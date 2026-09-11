import type { AssistantMessage, AssistantMessageEventStream, Model } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { InteractionUpdate, RunResult, TokenUsage } from "@cursor/sdk";

export interface RunProjection {
	answerText: string;
	stepId?: number;
	reportedUsage?: TokenUsage;
}

export interface CursorAssistantMessage extends AssistantMessage {
	cursorSdk: {
		tokenUsage: "actual" | "unavailable";
		cost: "unavailable";
		// Public SDK usage is cumulative billing, not an authoritative context snapshot.
		contextOccupancy: { status: "unavailable" };
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
		} else if (update.type === "tool-call-started") {
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
	}
}

export function applyToolCall(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	toolCall: { id: string; name: string; arguments: Record<string, unknown> },
): void {
	endLastOpenBlock(stream, partial);
	partial.content.push({ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments });
	const contentIndex = partial.content.length - 1;
	const block = partial.content[contentIndex];
	if (block.type !== "toolCall") return;
	stream.push({ type: "toolcall_start", contentIndex, partial });
	stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
	stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
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
