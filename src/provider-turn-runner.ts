import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";
import type { ModelSelection, RunResult } from "@cursor/sdk";
import { DEFAULT_AGENT_INSTANCE_ID } from "./constants.js";
import { requireCursorApiKey } from "./auth.js";
import { sanitizeCursorProviderError } from "./errors.js";
import { readHostBridge, type HostSnapshotV1, type OmpHostBridgeV1 } from "./contracts.js";
import { HOST_BRIDGE_OPTION_KEY } from "./host-option.js";
import { grantedToolsFromContext, trailingToolResults } from "./omp-tools.js";
import { mergeGrantedTools } from "./tool-catalog.js";
import {
	collectParkedBatch,
	resumeParked,
	startSend,
	stopWaitingForPark,
	waitForCancelled,
	waitForParked,
	waitForResult,
	bindLiveAbort,
	getLiveRun,
} from "./live-run.js";
import { commitTurn, disposeRuntimeForScope, finishLiveKeepAgent, finishTurnFailed, getRuntimeSlot, prepareTurn, runtimeKey, type PreparedTurn, type RuntimeSlot } from "./session-runtime.js";
import { captureCursorRequestOwner, getCursorSessionCwd, ownerForRequest, withCursorSessionOwner, type CursorSessionOwner } from "./session-scope.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";
import { ensureCursorModels, getModelMetadata, buildModelSelection } from "./catalog.js";
import { getFastMode } from "./model-controls.js";
import {
	applyInteractionUpdate,
	applyToolCall,
	closeOpenBlocks,
	deliverWithoutUnendedPreviews,
	runResultToStopReason,
	projectRunUsage,
	reconcileRunResult,
	type CursorAssistantMessage,
} from "./projector.js";
import { readSettledCheckpointOccupancy } from "./native-history.js";
import { stageCursorCompaction } from "./native-summary-compaction.js";
import { openJsonlStore } from "./sdk-session.js";
import { nativeReadHooked, rememberNativeEditToolCall, runWithNativeTools } from "./sdk-native-hook.js";

const bridgeOwners = new Map<string, { owner: CursorSessionOwner; signal: AbortSignal; onAbort: () => void }>();

function selectionForTurn(model: Model<Api>, apiKey: string, options?: SimpleStreamOptions): ModelSelection {
	const thinkingLevel = options?.disableReasoning ? "off" : (options?.reasoning ?? "off");
	const metadata = getModelMetadata(model.id, apiKey);
	const standard = metadata?.extendedContext?.standardContextWindow;
	return buildModelSelection(model.id, thinkingLevel, {
		apiKey,
		fastEnabled: getFastMode(metadata?.baseModelId ?? model.id),
		extendedContextEnabled: standard === undefined ? undefined : (model.contextWindow ?? 0) > standard,
	});
}

type PreparedProviderTurn = Readonly<PreparedTurn & {
	cwd: string;
	agentInstanceId: string;
	host: OmpHostBridgeV1 | undefined;
	snapshot: HostSnapshotV1 | undefined;
	modelSelection: ModelSelection | undefined;
}>;

type DriveOutcome =
	| { kind: "yielded" }
	| { kind: "cancelled"; beforeSend: boolean }
	| { kind: "finished"; result: RunResult };

export class ProviderTurnRunner {
	private slot?: RuntimeSlot;
	private abortSignal?: AbortSignal;
	private apiKey?: string;
	private owner?: CursorSessionOwner;
	private ownerGeneration?: number;
	private auxiliary = false;

	constructor(
		private readonly model: Model<Api>,
		private context: Context,
		private readonly options: SimpleStreamOptions | undefined,
		private readonly stream: AssistantMessageEventStream,
		private readonly partial: CursorAssistantMessage,
	) {}

	private assertCurrent(): void {
		this.abortSignal?.throwIfAborted();
		this.slot?.preparation?.signal.throwIfAborted();
		if (this.owner && this.ownerGeneration !== undefined && this.owner.generation !== this.ownerGeneration) {
			throw new Error("Cursor SDK session changed during the request");
		}
		if (this.slot && getRuntimeSlot(this.slot.key) !== this.slot) throw new Error("Cursor SDK turn was superseded");
	}

	async run(): Promise<void> {
		const { options, stream, partial } = this;
		try {
			const host = readHostBridge((options as Record<string, unknown> | undefined)?.[HOST_BRIDGE_OPTION_KEY]);
			this.abortSignal = host?.signal && options?.signal ? AbortSignal.any([host.signal, options.signal]) : host?.signal ?? options?.signal;
			this.abortSignal?.throwIfAborted();
			const snapshot = host?.snapshot();
			const request = await captureCursorRequestOwner(() => options?.onPayload?.(this.context, this.model));
			if (request.value !== undefined && request.value !== null) {
				if (typeof request.value !== "object" || !("messages" in request.value) || !Array.isArray(request.value.messages)) {
					throw new Error("Cursor SDK onPayload must return a Context with a messages array");
				}
				this.context = request.value as Context;
			}
			this.owner = request.owner;
			if (!this.owner && host && snapshot) {
				const key = JSON.stringify([snapshot.sessionId, snapshot.agentInstanceId]);
				const previous = bridgeOwners.get(key);
				previous?.signal.removeEventListener("abort", previous.onAbort);
				const bridgeOwner = previous?.owner ?? ownerForRequest(snapshot.sessionId, snapshot.cwd);
				const signal = this.abortSignal ?? host.signal;
				const binding = {
					owner: bridgeOwner,
					signal,
					onAbort: (): void => {
						if (bridgeOwners.get(key) !== binding) return;
						bridgeOwners.delete(key);
						void disposeRuntimeForScope(bridgeOwner.scopeKey);
					},
				};
				bridgeOwners.set(key, binding);
				signal.addEventListener("abort", binding.onAbort, { once: true });
				if (signal.aborted) binding.onAbort();
				this.owner = bridgeOwner;
			}
			this.auxiliary = !this.owner;
			this.owner ??= ownerForRequest(options?.sessionId, options?.cwd);
			this.ownerGeneration = request.generation ?? this.owner.generation;
			this.assertCurrent();
			await withCursorSessionOwner(this.owner, async () => {
				const prepared = await this.prepareTurnRequest(host, snapshot);
				bindLiveAbort(prepared.live, this.abortSignal, () => {
					if (!this.slot) return;
					void finishTurnFailed(this.slot, "aborted");
				});
				if (prepared.live.cancelled) {
					await this.finalizeTurn(prepared, { kind: "cancelled", beforeSend: true });
					return;
				}
				await this.sendTurn(prepared);
				await this.finalizeTurn(prepared, await this.driveTurn(prepared));
			});
		} catch (error) {
			const aborted = this.abortSignal?.aborted || this.slot?.preparation?.signal.aborted ||
				(this.owner && this.ownerGeneration !== undefined && this.owner.generation !== this.ownerGeneration);
			if (this.slot) await finishTurnFailed(this.slot, "send failed");
			delete partial.usage.contextTokens;
			partial.stopReason = aborted ? "aborted" : "error";
			partial.errorMessage = aborted ? "Cancelled" : sanitizeCursorProviderError(error, this.apiKey);
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: partial });
			stream.end(partial);
		} finally {
			if (this.auxiliary && this.owner) await disposeRuntimeForScope(this.owner.scopeKey);
		}
	}

	private async prepareTurnRequest(host: OmpHostBridgeV1 | undefined, snapshot: HostSnapshotV1 | undefined): Promise<PreparedProviderTurn> {
		const { model, options, stream, partial } = this;
		const cwd = snapshot?.cwd ?? (typeof options?.cwd === "string" && options.cwd ? options.cwd : getCursorSessionCwd());
		const agentInstanceId = snapshot?.agentInstanceId ?? options?.sessionId ?? DEFAULT_AGENT_INSTANCE_ID;
		this.apiKey = requireCursorApiKey(typeof options?.apiKey === "string" ? options.apiKey : undefined);
		const rawGranted = snapshot
			? snapshot.grantedTools
			: mergeGrantedTools(grantedToolsFromContext(this.context));
		const includeWebSearch = (snapshot ? rawGranted : this.context.tools)?.some((tool) => tool.name === "web_search") ?? false;
		const grantedTools = rawGranted.filter((tool) => tool.name !== "web_search");
		if (this.auxiliary && grantedTools.length > 0) {
			throw new Error("Cursor SDK tool calls require an OMP request context or an explicit host bridge");
		}
		stream.push({ type: "start", partial });

		let modelSelection: ModelSelection | undefined;
		if (trailingToolResults(this.context).length === 0 || !getLiveRun(runtimeKey(undefined, agentInstanceId))) {
			const discovery = ensureCursorModels(this.apiKey);
			if (this.abortSignal) {
				const signal = this.abortSignal;
				let onAbort: (() => void) | undefined;
				const cancelled = new Promise<void>((resolve) => {
					onAbort = resolve;
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) resolve();
				});
				try {
					await Promise.race([discovery, cancelled]);
				} finally {
					if (onAbort) signal.removeEventListener("abort", onAbort);
				}
			} else {
				await discovery;
			}
			this.assertCurrent();
			modelSelection = selectionForTurn(model, this.apiKey, options);
		}
		this.assertCurrent();
		const prepared = await prepareTurn({
			cwd,
			agentInstanceId,
			apiKey: this.apiKey,
			modelSelection,
			modelLimits: { contextWindow: model.contextWindow, maxTokens: model.maxTokens },
			context: this.context,
			grantedTools,
			includeWebSearch,
			host,
			signal: this.abortSignal,
		});
		this.slot = prepared.slot;
		this.assertCurrent();
		prepared.live.sink = { stream, partial };
		if (prepared.live.projection.previews) {
			for (const [id, preview] of prepared.live.projection.previews) {
				if (!preview.ended) prepared.live.projection.previews.delete(id);
			}
		}
		return { ...prepared, cwd, agentInstanceId, host, snapshot, modelSelection };
	}

	private async sendTurn(prepared: PreparedProviderTurn): Promise<void> {
		const { live, continuing, customTools, prompt, modelSelection } = prepared;
		if (continuing) {
			resumeParked(live, this.context);
			return;
		}
		if (!live.agent || prompt === undefined) {
			throw new Error("Cursor SDK live run is missing an agent or user prompt");
		}
		const agent = live.agent;
		const userPrompt = prompt;
		if (!modelSelection) {
			throw new Error("Cannot send a Cursor SDK turn without a model selection");
		}
		if (prepared.nativeRebase && prepared.host) {
			await prepared.host.commitBinding({
				version: 1,
				ompSessionId: prepared.snapshot?.sessionId ?? prepared.slot.scopeKey,
				agentInstanceId: prepared.agentInstanceId,
				branchEpoch: prepared.snapshot?.branchEpoch ?? 0,
				sdkAgentId: agent.agentId,
				workspaceIdentity: prepared.cwd,
				credentialScopeId: prepared.slot.credentialScopeId ?? "cursor-sdk",
				configFingerprint: prepared.snapshot?.configFingerprint ?? "",
				committedLeafId: prepared.nativeRebase.compactionEntryId,
				effectiveHistoryDigest: prepared.nativeRebase.effectiveHistoryDigest,
				state: "committed",
			});
			this.assertCurrent();
		}
		if (live.checkpointStore) {
			try {
				const baseline = await live.checkpointStore.agents.get({ agentId: agent.agentId });
				if (baseline?.agentId === agent.agentId) {
					live.checkpointBaseline = { rootBlobId: baseline.latestCheckpoint?.rootBlobId ?? null };
				}
			} catch {
				// Unknown previous root: occupancy stays unavailable.
			}
			live.summaryProbe?.seed(live.checkpointBaseline?.rootBlobId ?? null);
			this.assertCurrent();
		}
		const starting = startSend(live, () =>
			withSdkExitSuppressed(() => {
				const send = () =>
					agent.send(userPrompt, {
						model: modelSelection,
						local: { customTools },
						onDelta: ({ update }) => {
							rememberNativeEditToolCall(update);
							const sink = live.sink;
							if (!sink || live.cancelled || getRuntimeSlot(prepared.slot.key) !== prepared.slot) return;
							applyInteractionUpdate(sink.stream, sink.partial, update, live.projection);
							if (update.type === "summary-started") void live.summaryProbe?.onSummaryStarted(agent.agentId);
							else if (update.type === "summary-completed") live.summaryProbe?.onSummaryCompleted();
						},
					});
				if (!nativeReadHooked) return send();
				return runWithNativeTools((name, args, sdkToolCallId) => live.toolExec.execute(name, args, sdkToolCallId), send);
			}),
		);
		void starting.catch(() => undefined);
	}

	private async driveTurn(prepared: PreparedProviderTurn): Promise<DriveOutcome> {
		const { live } = prepared;
		const { stream, partial } = this;
		const parked = waitForParked(live);
		const finished = waitForResult(live).then((result) => ({ kind: "finished" as const, result }));
		const cancelled = waitForCancelled(live).then(() => ({ kind: "cancelled" as const }));
		const first = await Promise.race([parked.then(() => ({ kind: "parked" as const })), finished, cancelled]);
		if (first.kind === "cancelled" || live.cancelled) {
			return { kind: "cancelled", beforeSend: false };
		}
		if (first.kind === "parked") {
			const batch = await collectParkedBatch(live);
			this.assertCurrent();
			projectRunUsage(partial, live.projection, live.run?.usage);
			for (const call of batch) {
				applyToolCall(stream, partial, { id: call.sdkToolCallId, name: call.name, arguments: call.args }, live.projection);
			}
			live.projection.answerText = "";
			partial.stopReason = "toolUse";
			const delivered = deliverWithoutUnendedPreviews(partial, live.projection, new Set(batch.map((call) => call.ompToolCallId)));
			stream.push({ type: "done", reason: "toolUse", message: delivered });
			stream.end(delivered);
			return { kind: "yielded" };
		}
		return { kind: "finished", result: first.result };
	}

	private async finalizeTurn(prepared: PreparedProviderTurn, outcome: DriveOutcome): Promise<void> {
		if (outcome.kind === "yielded") return;
		const { live, slot: preparedSlot, host, snapshot, cwd, agentInstanceId, incremental } = prepared;
		const { stream, partial } = this;
		if (outcome.kind === "cancelled") {
			if (!outcome.beforeSend) projectRunUsage(partial, live.projection, live.run?.usage);
			partial.stopReason = "aborted";
			partial.errorMessage = "Cancelled";
			const delivered = deliverWithoutUnendedPreviews(partial, live.projection, new Set());
			stream.push({ type: "error", reason: "aborted", error: delivered });
			stream.end(delivered);
			await finishTurnFailed(preparedSlot, outcome.beforeSend ? "aborted" : "cancelled");
			return;
		}
		stopWaitingForPark(live);
		projectRunUsage(partial, live.projection, outcome.result.usage ?? live.run?.usage);
		reconcileRunResult(stream, partial, live.projection, outcome.result);
		if (host) await host.flushToolResults();
		this.assertCurrent();
		closeOpenBlocks(stream, partial);
		partial.stopReason = runResultToStopReason(outcome.result);
		if (outcome.result.status === "error") {
			partial.errorMessage = sanitizeCursorProviderError(
				{ ...outcome.result.error, requestId: outcome.result.requestId }, this.apiKey,
			);
			const delivered = deliverWithoutUnendedPreviews(partial, live.projection, new Set());
			stream.push({ type: "error", reason: "error", error: delivered });
			stream.end(delivered);
			await finishTurnFailed(preparedSlot, "run error");
			return;
		}
		if (outcome.result.status === "cancelled") {
			partial.errorMessage = "Cancelled";
			const delivered = deliverWithoutUnendedPreviews(partial, live.projection, new Set());
			stream.push({ type: "error", reason: "aborted", error: delivered });
			stream.end(delivered);
			await finishTurnFailed(preparedSlot, "cancelled");
			return;
		}
		const settledAgent = live.agent;
		let occupancy;
		if (settledAgent && live.checkpointBaseline &&
			(!live.run || live.run.agentId === settledAgent.agentId)) {
			const occupancyStore = live.checkpointStore ?? openJsonlStore(preparedSlot.storeIdentity.stateRoot);
			for (let attempt = 0; attempt < 10 && !live.cancelled; attempt++) {
				occupancy = await Promise.race([
					readSettledCheckpointOccupancy(
						attempt === 0 ? occupancyStore : openJsonlStore(preparedSlot.storeIdentity.stateRoot),
						settledAgent.agentId,
						live.checkpointBaseline.rootBlobId,
					),
					waitForCancelled(live).then(() => undefined),
				]);
				if (occupancy || live.cancelled) break;
				const delay = Promise.withResolvers<void>();
				setTimeout(delay.resolve, 25);
				await Promise.race([delay.promise, waitForCancelled(live)]);
			}
			this.assertCurrent();
		}
		commitTurn(preparedSlot, this.context, incremental);
		if (host) {
			await host.commitBinding({
				version: 1,
				ompSessionId: snapshot?.sessionId ?? preparedSlot.scopeKey,
				agentInstanceId,
				branchEpoch: snapshot?.branchEpoch ?? 0,
				sdkAgentId: live.agent?.agentId ?? "",
				workspaceIdentity: cwd,
				credentialScopeId: preparedSlot.credentialScopeId ?? "cursor-sdk",
				configFingerprint: snapshot?.configFingerprint ?? "",
				committedLeafId: snapshot?.committedLeafId ?? "",
				effectiveHistoryDigest: preparedSlot.sendState.contextFingerprint,
				state: "committed",
			});
		}
		this.assertCurrent();
		const observation = !live.cancelled ? await live.summaryProbe?.flush() : undefined;
		if (!live.cancelled && settledAgent && getLiveRun(preparedSlot.key) === live &&
			preparedSlot.agent === settledAgent && live.agent === settledAgent) {
			if (occupancy) {
				if (partial.cursorSdk.summary) partial.cursorSdk.summary.checkpointRootBlobId = occupancy.rootBlobId;
				partial.cursorSdk.contextOccupancy = occupancy;
			}
			if (observation && partial.cursorSdk.summary?.status === "completed") {
				partial.cursorSdk.summary.probe = observation;
				const store = live.checkpointStore ?? preparedSlot.store;
				if (store) {
					await stageCursorCompaction({
						observation,
						context: this.context,
						contextFingerprint: preparedSlot.sendState.contextFingerprint,
						store,
						slot: preparedSlot,
						agentId: settledAgent.agentId,
						...(this.abortSignal ? { signal: this.abortSignal } : {}),
					});
				}
				this.assertCurrent();
			}
		}
		this.assertCurrent();
		const delivered = deliverWithoutUnendedPreviews(partial, live.projection, new Set());
		stream.push({ type: "done", reason: "stop", message: delivered });
		stream.end(delivered);
		await finishLiveKeepAgent(preparedSlot, "run finished");
	}
}
