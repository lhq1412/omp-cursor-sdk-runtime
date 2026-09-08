import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID, DEFAULT_AGENT_INSTANCE_ID } from "./constants.js";
import { requireCursorApiKey } from "./auth.js";
import { readHostBridge } from "./contracts.js";
import { HOST_BRIDGE_OPTION_KEY } from "./host-option.js";
import { grantedToolsFromContext } from "./omp-tools.js";
import { mergeGrantedTools } from "./tool-catalog.js";
import {
	collectParkedBatch,
	resumeParked,
	startSend,
	stopWaitingForPark,
	waitForParked,
	waitForResult,
} from "./live-run.js";
import { commitTurn, finishLiveKeepAgent, finishTurnFailed, prepareTurn, type RuntimeSlot } from "./session-runtime.js";
import { getCursorSessionCwd } from "./session-scope.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";
import { defaultModelSelection } from "./sdk-session.js";
import {
	applyInteractionUpdate,
	applyToolCall,
	closeOpenBlocks,
	createEmptyAssistantMessage,
	createProviderStream,
	runResultToStopReason,
} from "./projector.js";

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
			const grantedTools = mergeGrantedTools(snapshot ? snapshot.grantedTools : grantedToolsFromContext(context));
			stream.push({ type: "start", partial });

			const prepared = await prepareTurn({
				cwd,
				agentInstanceId,
				apiKey,
				modelId: model.id,
				context,
				grantedTools,
				host,
			});
			const { slot: preparedSlot, live, continuing, customTools, prompt, incremental } = prepared;
			slot = preparedSlot;
			live.sink = { stream, partial };

			if (continuing) {
				resumeParked(live, context);
			} else {
				if (!live.agent || prompt === undefined) {
					throw new Error("Cursor SDK live run is missing an agent or user prompt");
				}
				const agent = live.agent;
				const userPrompt = prompt;
				const starting = startSend(live, () =>
					withSdkExitSuppressed(() =>
						agent.send(userPrompt, {
							model: defaultModelSelection(model.id),
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

			const abortSignal = host?.signal ?? options?.signal;
			const onAbort = () => {
				if (!slot) return;
				void finishTurnFailed(slot, "aborted");
			};
			abortSignal?.addEventListener("abort", onAbort, { once: true });
			try {
				if (abortSignal?.aborted && live.run?.supports("cancel")) {
					await live.run.cancel();
				}
				const parked = waitForParked(live);
				const finished = waitForResult(live).then((result) => ({ kind: "finished" as const, result }));
				const first = await Promise.race([parked.then(() => ({ kind: "parked" as const })), finished]);
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
						credentialScopeId: "cursor-sdk",
						configFingerprint: snapshot?.configFingerprint ?? "",
						committedLeafId: snapshot?.committedLeafId ?? "",
						effectiveHistoryDigest: preparedSlot.sendState.contextFingerprint,
						state: "committed",
					});
				}
				stream.push({ type: "done", reason: "stop", message: partial });
				stream.end(partial);
				await finishLiveKeepAgent(preparedSlot.key, "run finished");
			} finally {
				abortSignal?.removeEventListener("abort", onAbort);
			}
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
