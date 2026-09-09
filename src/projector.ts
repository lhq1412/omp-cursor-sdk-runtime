import type { AssistantMessage, AssistantMessageEventStream, Model } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { InteractionUpdate, RunResult } from "@cursor/sdk";

export function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function applyTextDelta(stream: AssistantMessageEventStream, partial: AssistantMessage, text: string): void {
	if (!text) return;
	const lastIndex = partial.content.length - 1;
	const last = partial.content[lastIndex];
	if (last?.type === "text") {
		last.text += text;
		stream.push({ type: "text_delta", contentIndex: lastIndex, delta: text, partial });
		return;
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
): void {
	if (update.type === "text-delta") {
		applyTextDelta(stream, partial, update.text);
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

export function createProviderStream(): AssistantMessageEventStream {
	return createAssistantMessageEventStream();
}
