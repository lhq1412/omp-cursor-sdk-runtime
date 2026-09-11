import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID, DEFAULT_AGENT_INSTANCE_ID } from "./constants.js";
import { requireCursorApiKey } from "./auth.js";
import { sanitizeCursorProviderError } from "./errors.js";
import { readHostBridge } from "./contracts.js";
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
import { commitTurn, disposeRuntimeForScope, finishLiveKeepAgent, finishTurnFailed, getRuntimeSlot, prepareTurn, runtimeKey, type RuntimeSlot } from "./session-runtime.js";
import { captureCursorRequestOwner, getCursorSessionCwd, ownerForRequest, withCursorSessionOwner, type CursorSessionOwner } from "./session-scope.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";
import { ensureCursorModels, getModelMetadata, buildModelSelection } from "./catalog.js";
import { getFastMode } from "./model-controls.js";
import type { ModelSelection } from "@cursor/sdk";
import {
	applyInteractionUpdate,
	applyToolCall,
	closeOpenBlocks,
	createEmptyAssistantMessage,
	createProviderStream,
	dropUnendedPreviews,
	runResultToStopReason,
	projectRunUsage,
	reconcileRunResult,
} from "./projector.js";

import { readSettledCheckpointOccupancy } from "./native-history.js";
import { openJsonlStore } from "./sdk-session.js";
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

export function streamCursorRuntime(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (model.provider !== CURSOR_SDK_PROVIDER_ID || model.api !== CURSOR_SDK_API) {
		throw new Error(`Provider ${CURSOR_SDK_PROVIDER_ID} only accepts ${CURSOR_SDK_API} models`);
	}
	const stream = createProviderStream();
	const partial = createEmptyAssistantMessage(model);
	queueMicrotask(async () => {
		let slot: RuntimeSlot | undefined;
		let abortSignal = options?.signal;
		let apiKey: string | undefined;
		let owner: CursorSessionOwner | undefined;
		let ownerGeneration: number | undefined;
		let auxiliary = false;
		const assertCurrent = () => {
			abortSignal?.throwIfAborted();
			slot?.preparation?.signal.throwIfAborted();
			if (owner && ownerGeneration !== undefined && owner.generation !== ownerGeneration) {
				throw new Error("Cursor SDK session changed during the request");
			}
			if (slot && getRuntimeSlot(slot.key) !== slot) throw new Error("Cursor SDK turn was superseded");
		};
		try {
			const host = readHostBridge((options as Record<string, unknown> | undefined)?.[HOST_BRIDGE_OPTION_KEY]);
			abortSignal = host?.signal && options?.signal ? AbortSignal.any([host.signal, options.signal]) : host?.signal ?? options?.signal;
			abortSignal?.throwIfAborted();
			const snapshot = host?.snapshot();
			const request = await captureCursorRequestOwner(() => options?.onPayload?.(context, model));
			if (request.value !== undefined && request.value !== null) {
				if (typeof request.value !== "object" || !("messages" in request.value) || !Array.isArray(request.value.messages)) {
					throw new Error("Cursor SDK onPayload must return a Context with a messages array");
				}
				context = request.value as Context;
			}
			owner = request.owner;
			if (!owner && host && snapshot) {
				const key = JSON.stringify([snapshot.sessionId, snapshot.agentInstanceId]);
				const previous = bridgeOwners.get(key);
				previous?.signal.removeEventListener("abort", previous.onAbort);
				const bridgeOwner = previous?.owner ?? ownerForRequest(snapshot.sessionId, snapshot.cwd);
				const signal = abortSignal ?? host.signal;
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
				owner = bridgeOwner;
			}
			auxiliary = !owner;
			owner ??= ownerForRequest(options?.sessionId, options?.cwd);
			ownerGeneration = request.generation ?? owner.generation;
			assertCurrent();
			await withCursorSessionOwner(owner, async () => {
				const cwd = snapshot?.cwd ?? (typeof options?.cwd === "string" && options.cwd ? options.cwd : getCursorSessionCwd());
				const agentInstanceId = snapshot?.agentInstanceId ?? options?.sessionId ?? DEFAULT_AGENT_INSTANCE_ID;
				apiKey = requireCursorApiKey(typeof options?.apiKey === "string" ? options.apiKey : undefined);
				const rawGranted = snapshot
					? snapshot.grantedTools
					: mergeGrantedTools(grantedToolsFromContext(context));
				const includeWebSearch = (snapshot ? rawGranted : context.tools)?.some((tool) => tool.name === "web_search") ?? false;
				const grantedTools = rawGranted.filter((tool) => tool.name !== "web_search");
				if (auxiliary && grantedTools.length > 0) {
					throw new Error("Cursor SDK tool calls require an OMP request context or an explicit host bridge");
				}
				stream.push({ type: "start", partial });

				let modelSelection: ModelSelection | undefined;
				if (trailingToolResults(context).length === 0 || !getLiveRun(runtimeKey(undefined, agentInstanceId))) {
					const discovery = ensureCursorModels(apiKey);
					if (abortSignal) {
						const signal = abortSignal;
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
					assertCurrent();
					modelSelection = selectionForTurn(model, apiKey, options);
				}
				assertCurrent();
				const prepared = await prepareTurn({
					cwd,
					agentInstanceId,
					apiKey,
					modelSelection,
					modelLimits: { contextWindow: model.contextWindow, maxTokens: model.maxTokens },
					context,
					grantedTools,
					includeWebSearch,
					host,
					signal: abortSignal,
				});
				const { slot: preparedSlot, live, continuing, customTools, prompt, incremental } = prepared;
				slot = preparedSlot;
				assertCurrent();
				live.sink = { stream, partial };
				if (live.projection.previews) {
					for (const [id, preview] of live.projection.previews) {
						if (!preview.ended) live.projection.previews.delete(id);
					}
				}

				bindLiveAbort(live, abortSignal, () => {
					if (!slot) return;
					void finishTurnFailed(slot, "aborted");
				});
				if (live.cancelled) {
					partial.stopReason = "aborted";
					partial.errorMessage = "Cancelled";
					stream.push({ type: "error", reason: "aborted", error: partial });
					stream.end(partial);
					await finishTurnFailed(preparedSlot, "aborted");
					return;
				}

				if (continuing) {
					resumeParked(live, context);
				} else {
					if (!live.agent || prompt === undefined) {
						throw new Error("Cursor SDK live run is missing an agent or user prompt");
					}
					const agent = live.agent;
					const userPrompt = prompt;
					if (!modelSelection) {
						throw new Error("Cannot send a Cursor SDK turn without a model selection");
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
						assertCurrent();
					}
					const starting = startSend(live, () =>
						withSdkExitSuppressed(() =>
							agent.send(userPrompt, {
								model: modelSelection,
								local: { customTools },
								onDelta: ({ update }) => {
									const sink = live.sink;
									if (!sink || live.cancelled || getRuntimeSlot(preparedSlot.key) !== preparedSlot) return;
									applyInteractionUpdate(sink.stream, sink.partial, update, live.projection);
								},
							}),
						),
					);
					void starting.catch(() => undefined);
				}

				const parked = waitForParked(live);
				const finished = waitForResult(live).then((result) => ({ kind: "finished" as const, result }));
				const cancelled = waitForCancelled(live).then(() => ({ kind: "cancelled" as const }));
				const first = await Promise.race([parked.then(() => ({ kind: "parked" as const })), finished, cancelled]);
				if (first.kind === "cancelled" || live.cancelled) {
					projectRunUsage(partial, live.projection, live.run?.usage);
					dropUnendedPreviews(partial, live.projection, new Set());
					partial.stopReason = "aborted";
					partial.errorMessage = "Cancelled";
					stream.push({ type: "error", reason: "aborted", error: partial });
					stream.end(partial);
					await finishTurnFailed(preparedSlot, "cancelled");
					return;
				}
				if (first.kind === "parked") {
					const batch = await collectParkedBatch(live);
					assertCurrent();
					projectRunUsage(partial, live.projection, live.run?.usage);
					for (const call of batch) {
						applyToolCall(stream, partial, { id: call.toolCallId, name: call.name, arguments: call.args }, live.projection);
					}
					dropUnendedPreviews(partial, live.projection, new Set(batch.map((call) => call.toolCallId)));
					live.projection.answerText = "";
					partial.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: partial });
					stream.end(partial);
					return;
				}
				stopWaitingForPark(live);
				projectRunUsage(partial, live.projection, first.result.usage ?? live.run?.usage);
				reconcileRunResult(stream, partial, live.projection, first.result);
				if (host) await host.flushToolResults();
				assertCurrent();
				dropUnendedPreviews(partial, live.projection, new Set());
				closeOpenBlocks(stream, partial);
				partial.stopReason = runResultToStopReason(first.result);
				if (first.result.status === "error") {
					partial.errorMessage = sanitizeCursorProviderError(
						{ ...first.result.error, requestId: first.result.requestId }, apiKey,
					);
					stream.push({ type: "error", reason: "error", error: partial });
					stream.end(partial);
					await finishTurnFailed(preparedSlot, "run error");
					return;
				}
				if (first.result.status === "cancelled") {
					partial.errorMessage = "Cancelled";
					stream.push({ type: "error", reason: "aborted", error: partial });
					stream.end(partial);
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
					assertCurrent();
				}
				commitTurn(preparedSlot, context, incremental);
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
				assertCurrent();
				if (occupancy && !live.cancelled && getLiveRun(preparedSlot.key) === live &&
					preparedSlot.agent === settledAgent && live.agent === settledAgent) {
					partial.usage.contextTokens = occupancy.usedTokens;
					partial.cursorSdk.contextOccupancy = occupancy;
				}
				stream.push({ type: "done", reason: "stop", message: partial });
				stream.end(partial);
				await finishLiveKeepAgent(preparedSlot, "run finished");
			});
		} catch (error) {
			const aborted = abortSignal?.aborted || slot?.preparation?.signal.aborted ||
				(owner && ownerGeneration !== undefined && owner.generation !== ownerGeneration);
			if (slot) await finishTurnFailed(slot, "send failed");
			delete partial.usage.contextTokens;
			partial.cursorSdk.contextOccupancy = { status: "unavailable" };
			partial.stopReason = aborted ? "aborted" : "error";
			partial.errorMessage = aborted ? "Cancelled" : sanitizeCursorProviderError(error, apiKey);
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: partial });
			stream.end(partial);
		} finally {
			if (auxiliary && owner) await disposeRuntimeForScope(owner.scopeKey);
		}
	});
	return stream;
}
