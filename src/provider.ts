import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID, DEFAULT_AGENT_INSTANCE_ID } from "./constants.js";
import { requireCursorApiKey } from "./auth.js";
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
} from "./live-run.js";
import { commitTurn, finishLiveKeepAgent, finishTurnFailed, prepareTurn, type RuntimeSlot } from "./session-runtime.js";
import { getCursorSessionCwd } from "./session-scope.js";
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
	runResultToStopReason,
} from "./projector.js";

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
		try {
			const host = readHostBridge((options as Record<string, unknown> | undefined)?.[HOST_BRIDGE_OPTION_KEY]);
			const snapshot = host?.snapshot();
			const cwd = snapshot?.cwd ?? (typeof options?.cwd === "string" && options.cwd ? options.cwd : getCursorSessionCwd());
			const agentInstanceId = snapshot?.agentInstanceId ?? DEFAULT_AGENT_INSTANCE_ID;
			const apiKey = requireCursorApiKey(typeof options?.apiKey === "string" ? options.apiKey : undefined);
			const grantedTools = snapshot
				? [...snapshot.grantedTools]
				: mergeGrantedTools(grantedToolsFromContext(context));
			stream.push({ type: "start", partial });

			let modelSelection: ModelSelection | undefined;
			if (trailingToolResults(context).length === 0) {
				await ensureCursorModels(apiKey);
				modelSelection = selectionForTurn(model, apiKey, options);
			}
			const prepared = await prepareTurn({
				cwd,
				agentInstanceId,
				apiKey,
				modelSelection,
				context,
				grantedTools,
				host,
			});
			const { slot: preparedSlot, live, continuing, customTools, prompt, incremental } = prepared;
			slot = preparedSlot;
			live.sink = { stream, partial };

			const abortSignal = host?.signal ?? options?.signal;
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
				const starting = startSend(live, () =>
					withSdkExitSuppressed(() =>
						agent.send(userPrompt, {
							model: modelSelection,
							local: { customTools },
							onDelta: ({ update }) => {
								const sink = live.sink;
								if (!sink) return;
								applyInteractionUpdate(sink.stream, sink.partial, update);
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
					partial.stopReason = "aborted";
					partial.errorMessage = "Cancelled";
					stream.push({ type: "error", reason: "aborted", error: partial });
					stream.end(partial);
					await finishTurnFailed(preparedSlot, "cancelled");
					return;
				}
				if (first.kind === "parked") {
					const batch = await collectParkedBatch(live);
					for (const call of batch) {
						applyToolCall(stream, partial, { id: call.toolCallId, name: call.name, arguments: call.args });
					}
					partial.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: partial });
					stream.end(partial);
					return;
				}
				stopWaitingForPark(live);
				if (host) await host.flushToolResults();
				closeOpenBlocks(stream, partial);
				partial.stopReason = runResultToStopReason(first.result);
				if (first.result.status === "error") {
					partial.errorMessage = first.result.error?.message ?? "Cursor SDK run failed";
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
				stream.push({ type: "done", reason: "stop", message: partial });
				stream.end(partial);
				await finishLiveKeepAgent(preparedSlot.key, "run finished");
		} catch (error) {
			if (slot) await finishTurnFailed(slot, "send failed");
			partial.stopReason = "error";
			partial.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: partial });
			stream.end(partial);
		}
	});
	return stream;
}
