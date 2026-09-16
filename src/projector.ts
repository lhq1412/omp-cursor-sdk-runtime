import type { AssistantMessage, AssistantMessageEventStream, Model } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { InteractionUpdate, RunResult, TokenUsage } from "@cursor/sdk";
import type { SummaryBoundaryObservation } from "./native-history.js";
import { projectSdkToolCallId } from "./tool-call-id.js";

export interface CursorSdkSummary {
	count: number;
	status: "running" | "completed";
	text?: string;
	checkpointRootBlobId?: string;
	probe?: SummaryBoundaryObservation;
}

export interface RunProjection {
	answerText: string;
	stepId?: number;
	reportedUsage?: TokenUsage;
	sdkToOmp?: ReadonlyMap<string, string>;
	allowToolPreview?: boolean;
	previews?: Map<string, { contentIndex: number; ended: boolean }>;
	/** SDK-native tool-call ID → OMP-portable ID for this run. */
	toolCallIds?: Map<string, string>;
	summary?: CursorSdkSummary;
}

export interface CursorAssistantMessage extends AssistantMessage {
	cursorSdk: {
		tokenUsage: "actual" | "unavailable";
		cost: "unavailable";
		// Run billing and the settled checkpoint's context occupancy are separate measurements.
		contextOccupancy: { status: "unavailable" } | {
			status: "actual";
			source: "checkpoint";
			agentId: string;
			rootBlobId: string;
			usedTokens: number;
			maxTokens: number;
		};
		summary?: CursorSdkSummary;
	};
}

export function createEmptyAssistantMessage(model: Model<Api>): CursorAssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		cursorSdk: {
			tokenUsage: "unavailable",
			cost: "unavailable",
			contextOccupancy: { status: "unavailable" },
		},
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			// Host Usage requires numbers. These placeholders are NOT free pricing; see cursorSdk.cost.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Map one SDK-native tool-call ID to the OMP-portable ID for this run. */
export function ompToolCallId(projection: RunProjection, sdkToolCallId: string): string {
	const existing = projection.toolCallIds?.get(sdkToolCallId);
	if (existing) return existing;
	const projected = projectSdkToolCallId(sdkToolCallId);
	(projection.toolCallIds ??= new Map()).set(sdkToolCallId, projected);
	return projected;
}

export function applyTextDelta(stream: AssistantMessageEventStream, partial: AssistantMessage, text: string, startNew = false): void {
	if (!text) return;
	const lastIndex = partial.content.length - 1;
	const last = partial.content[lastIndex];
	if (last?.type === "text" && !startNew) {
		last.text += text;
		stream.push({ type: "text_delta", contentIndex: lastIndex, delta: text, partial });
		return;
	}
	if (last?.type === "text") {
		endLastOpenBlock(stream, partial);
	}
	partial.content.push({ type: "text", text });
	const contentIndex = partial.content.length - 1;
	stream.push({ type: "text_start", contentIndex, partial });
	stream.push({ type: "text_delta", contentIndex, delta: text, partial });
}

export function applyThinkingDelta(stream: AssistantMessageEventStream, partial: AssistantMessage, text: string): void {
	if (!text) return;
	const lastIndex = partial.content.length - 1;
	const last = partial.content[lastIndex];
	if (last?.type === "thinking") {
		last.thinking += text;
		stream.push({ type: "thinking_delta", contentIndex: lastIndex, delta: text, partial });
		return;
	}
	partial.content.push({ type: "thinking", thinking: text });
	const contentIndex = partial.content.length - 1;
	stream.push({ type: "thinking_start", contentIndex, partial });
	stream.push({ type: "thinking_delta", contentIndex, delta: text, partial });
}

function mcpCustomCall(update: InteractionUpdate): { callId: string; sdkName: string; args: Record<string, unknown> } | undefined {
	if (update.type !== "partial-tool-call" && update.type !== "tool-call-started") return;
	if (update.toolCall.type !== "mcp") return;
	const sdkName = update.toolCall.args.toolName;
	if (!sdkName) return;
	const inner = update.toolCall.args.args;
	const args = inner && typeof inner === "object" && !Array.isArray(inner) ? inner : {};
	return { callId: update.callId, sdkName, args };
}

function previewMcpToolCall(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	update: InteractionUpdate,
	projection?: RunProjection,
): void {
	const call = mcpCustomCall(update);
	if (!call || projection?.allowToolPreview !== true || !projection.sdkToOmp) return;
	const name = projection.sdkToOmp.get(call.sdkName);
	if (!name) return;
	const previews = projection.previews ??= new Map();
	const ompId = ompToolCallId(projection, call.callId);
	const existing = previews.get(ompId);
	if (existing?.ended) return;
	let contentIndex = partial.content.findIndex((block) => block.type === "toolCall" && block.id === ompId);
	if (contentIndex < 0 && existing) {
		const block = partial.content[existing.contentIndex];
		if (block?.type === "toolCall") contentIndex = existing.contentIndex;
	}
	if (contentIndex >= 0) {
		const block = partial.content[contentIndex];
		if (block?.type === "toolCall") {
			block.name = name;
			block.arguments = call.args;
		}
		previews.set(ompId, { contentIndex, ended: false });
		return;
	}
	endLastOpenBlock(stream, partial);
	partial.content.push({ type: "toolCall", id: ompId, name, arguments: call.args });
	contentIndex = partial.content.length - 1;
	previews.set(ompId, { contentIndex, ended: false });
	stream.push({ type: "toolcall_start", contentIndex, partial });
}

export function applyInteractionUpdate(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	update: InteractionUpdate,
	projection?: RunProjection,
): void {
	const startNew = Boolean(projection && update.type === "text-delta" && projection.answerText === "");
	if (projection) {
		if (update.type === "step-started" && update.stepId !== projection.stepId) {
			projection.stepId = update.stepId;
			projection.answerText = "";
		} else if (update.type === "tool-call-started" || update.type === "partial-tool-call") {
			projection.answerText = "";
		} else if (update.type === "text-delta") {
			projection.answerText += update.text;
		}
	}
	if (update.type === "text-delta") {
		applyTextDelta(stream, partial, update.text, startNew);
		return;
	}
	if (update.type === "thinking-delta") {
		applyThinkingDelta(stream, partial, update.text);
		return;
	}
	if (update.type === "summary-started" || update.type === "summary" || update.type === "summary-completed") {
		if (hasCursorSdk(partial)) applySummaryUpdate(partial, update, projection);
		return;
	}
	previewMcpToolCall(stream, partial, update, projection);
}

export function applyToolCall(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	toolCall: { id: string; name: string; arguments: Record<string, unknown> },
	projection?: RunProjection,
): void {
	// toolCall.id is SDK-native; every emitted block/event id is OMP-portable.
	const id = projection ? ompToolCallId(projection, toolCall.id) : projectSdkToolCallId(toolCall.id);
	const preview = projection?.previews?.get(id);
	if (preview?.ended) return;
	let contentIndex = partial.content.findIndex((block) => block.type === "toolCall" && block.id === id);
	if (contentIndex < 0 && preview) {
		const block = partial.content[preview.contentIndex];
		if (block?.type === "toolCall") contentIndex = preview.contentIndex;
	}
	if (contentIndex >= 0) {
		const block = partial.content[contentIndex];
		if (block.type !== "toolCall") return;
		block.id = id;
		block.name = toolCall.name;
		block.arguments = toolCall.arguments;
		stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
		stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
		if (projection) {
			(projection.previews ??= new Map()).set(id, { contentIndex, ended: true });
		}
		return;
	}
	endLastOpenBlock(stream, partial);
	partial.content.push({ type: "toolCall", id, name: toolCall.name, arguments: toolCall.arguments });
	contentIndex = partial.content.length - 1;
	const block = partial.content[contentIndex];
	if (block.type !== "toolCall") return;
	stream.push({ type: "toolcall_start", contentIndex, partial });
	stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
	stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
	if (projection) {
		(projection.previews ??= new Map()).set(id, { contentIndex, ended: true });
	}
}

export function deliverWithoutUnendedPreviews(
	partial: AssistantMessage,
	projection: RunProjection,
	keepIds: ReadonlySet<string>,
): AssistantMessage {
	const previews = projection.previews;
	let content = partial.content;
	let changed = false;
	if (previews) {
		const filtered = partial.content.filter((block) => {
			if (block.type !== "toolCall" || keepIds.has(block.id)) return true;
			const preview = previews.get(block.id);
			if (!preview || preview.ended) return true;
			previews.delete(block.id);
			changed = true;
			return false;
		});
		if (changed) content = filtered;
	}
	const lastById = new Map<string, number>();
	let toolCalls = 0;
	for (let i = 0; i < content.length; i += 1) {
		const block = content[i]!;
		if (block.type !== "toolCall") continue;
		toolCalls += 1;
		lastById.set(block.id, i);
	}
	if (lastById.size < toolCalls) {
		content = content.filter((block, index) => block.type !== "toolCall" || lastById.get(block.id) === index);
		changed = true;
	}
	return changed ? { ...partial, content } : partial;
}

export function endLastOpenBlock(stream: AssistantMessageEventStream, partial: AssistantMessage): void {
	const contentIndex = partial.content.length - 1;
	const last = partial.content[contentIndex];
	if (!last) return;
	if (last.type === "text") {
		stream.push({ type: "text_end", contentIndex, content: last.text, partial });
	} else if (last.type === "thinking") {
		stream.push({ type: "thinking_end", contentIndex, content: last.thinking, partial });
	}
}

export function closeOpenBlocks(stream: AssistantMessageEventStream, partial: AssistantMessage): void {
	partial.content.forEach((block, contentIndex) => {
		if (block.type === "text") {
			stream.push({ type: "text_end", contentIndex, content: block.text, partial });
		} else if (block.type === "thinking") {
			stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
		}
	});
}

export function runResultToStopReason(result: RunResult): AssistantMessage["stopReason"] {
	if (result.status === "cancelled") return "aborted";
	if (result.status === "error") return "error";
	return "stop";
}

export function reconcileRunResult(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	projection: RunProjection,
	result: RunResult,
): void {
	if (!result.result) return;
	const emitted = projection.answerText;
	const final = result.result;
	if (final.startsWith(emitted)) {
		applyTextDelta(stream, partial, final.slice(emitted.length), emitted === "");
	} else {
		for (let index = partial.content.length - 1; index >= 0; index -= 1) {
			const block = partial.content[index];
			if (block.type === "toolCall") break;
			if (block.type === "text") {
				block.text = final;
				projection.answerText = final;
				return;
			}
		}
		applyTextDelta(stream, partial, final);
	}
	projection.answerText = final;
}

function hasCursorSdk(partial: AssistantMessage): partial is CursorAssistantMessage {
	return "cursorSdk" in partial;
}

export function projectRunSummary(partial: AssistantMessage, projection: Pick<RunProjection, "summary">): void {
	if (!projection.summary || !hasCursorSdk(partial)) return;
	partial.cursorSdk.summary = { ...projection.summary };
}

function applySummaryUpdate(
	partial: CursorAssistantMessage,
	update: InteractionUpdate,
	projection?: RunProjection,
): void {
	const current = projection?.summary ?? partial.cursorSdk.summary;
	let next: CursorSdkSummary;
	if (update.type === "summary-started") {
		next = { count: current?.count ?? 0, status: "running" };
	} else if (update.type === "summary") {
		next = { ...(current ?? { count: 0, status: "running" }), text: update.summary };
	} else if (update.type === "summary-completed") {
		const base = current ?? { count: 0, status: "running" };
		next = { ...base, count: base.count + 1, status: "completed" };
	} else {
		return;
	}
	if (projection) projection.summary = next;
	partial.cursorSdk.summary = { ...next };
}

export function projectRunUsage(
	partial: CursorAssistantMessage,
	projection: RunProjection,
	usage: TokenUsage | undefined,
): void {
	if (!usage) return;
	partial.cursorSdk.tokenUsage = "actual";
	const previous = projection.reportedUsage;
	// SDK Run billing is orchestration, not one conversation prompt.
	const orchestration = partial.usage.orchestration ??= {};
	const fields = [
		["input", "inputTokens"], ["output", "outputTokens"],
		["cacheRead", "cacheReadTokens"], ["input", "cacheWriteTokens"],
	] as const;
	for (const [host, sdk] of fields) {
		orchestration[host] = (orchestration[host] ?? 0) + Math.max(0, usage[sdk] - (previous?.[sdk] ?? 0));
	}
	partial.usage.totalTokens = (orchestration.input ?? 0) + (orchestration.output ?? 0) + (orchestration.cacheRead ?? 0);
	if (usage.reasoningTokens !== undefined) {
		partial.usage.reasoningTokens = (partial.usage.reasoningTokens ?? 0)
			+ Math.max(0, usage.reasoningTokens - (previous?.reasoningTokens ?? 0));
	}
	// Keep the high-water mark on the SDK run, not the short-lived OMP message.
	projection.reportedUsage = {
		inputTokens: Math.max(usage.inputTokens, previous?.inputTokens ?? 0),
		outputTokens: Math.max(usage.outputTokens, previous?.outputTokens ?? 0),
		cacheReadTokens: Math.max(usage.cacheReadTokens, previous?.cacheReadTokens ?? 0),
		cacheWriteTokens: Math.max(usage.cacheWriteTokens, previous?.cacheWriteTokens ?? 0),
		totalTokens: Math.max(usage.totalTokens, previous?.totalTokens ?? 0),
		reasoningTokens: usage.reasoningTokens === undefined ? previous?.reasoningTokens
			: Math.max(usage.reasoningTokens, previous?.reasoningTokens ?? 0),
	};
}

export function createProviderStream(): AssistantMessageEventStream {
	return createAssistantMessageEventStream();
}
