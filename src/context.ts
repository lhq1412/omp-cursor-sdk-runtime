import { createHash } from "node:crypto";
import type { SDKImage, SDKUserMessage } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	CURSOR_SDK_API,
	CURSOR_SDK_PROVIDER_ID,
	MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
	SDK_TOOL_CONTEXT,
} from "./constants.js";

export type SendMode = "bootstrap" | "incremental";

export interface SendState {
	bootstrapped: boolean;
	contextFingerprint: string;
	incrementalSendCount: number;
}

export interface SendPlan {
	mode: SendMode;
	resetAgent: boolean;
	reason: "initial" | "context_divergence" | "incremental_threshold" | "incremental";
	continueOnly?: true;
}

export interface ModelInputLimits {
	contextWindow: number | null;
	maxTokens: number | null;
}

export interface PreparedSendInput {
	prompt: SDKUserMessage;
	history?: Context["messages"];
}

const NATIVE_HISTORY_FORMAT = "native-checkpoint-v1";

export function nativeToolCallId(id: string): string {
	return createHash("sha256").update("omp-native-history:tool-call\0").update(id).digest("hex");
}

export function registerCursorToolCallIds(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("context", (event, ctx) => {
		if (ctx.model?.api !== "openai-codex-responses") return;

		const callIds = new Map<string, string>();
		// Context messages are deep copies; leave persisted history and live SDK callback IDs untouched.
		for (const message of event.messages) {
			if (message.role === "assistant") {
				const cursorOrigin = message.provider === CURSOR_SDK_PROVIDER_ID && message.api === CURSOR_SDK_API;
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const id = block.id;
					if (cursorOrigin && id.length > 64) {
						const mappedId = nativeToolCallId(id);
						callIds.set(id, mappedId);
						block.id = mappedId;
					} else {
						// A later call with the same raw ID owns subsequent results.
						callIds.delete(id);
					}
				}
			} else if (message.role === "toolResult") {
				const mappedId = callIds.get(message.toolCallId);
				if (mappedId) message.toolCallId = mappedId;
			}
		}
		return { messages: event.messages };
	});
}

function hashValue(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function serializeSystemPrompt(systemPrompt: string | readonly string[] | undefined): string {
	return typeof systemPrompt === "string" ? systemPrompt : systemPrompt?.join("\n") ?? "";
}

function sanitizeSystemPromptForCursor(systemPrompt: string): string {
	if (!systemPrompt.startsWith("<system-conventions>")) return systemPrompt.trim();
	const toolPolicyStart = systemPrompt.indexOf("\n# Internal URLs\n");
	if (toolPolicyStart < 0) return systemPrompt.trim();
	const workflowStart = systemPrompt.indexOf("\n§ Workflow\n", toolPolicyStart);
	if (workflowStart < 0) return systemPrompt.trim();
	return [
		systemPrompt.slice(0, toolPolicyStart).trimEnd(),
		"OMP host tool catalog and tool policy omitted: Cursor can call only Cursor SDK tools exposed in this run.",
		systemPrompt.slice(workflowStart).trimStart(),
	].join("\n\n");
}

export function computeContextFingerprint(context: Context): string {
	const systemHash = hashValue(serializeSystemPrompt(context.systemPrompt));
	const messageHashes = context.messages.map((message, index) => {
		const role = "role" in message && typeof message.role === "string" ? message.role : "unknown";
		return hashValue(`${index}:${role}:${JSON.stringify(message)}`);
	});
	return JSON.stringify({ format: NATIVE_HISTORY_FORMAT, systemHash, messageHashes });
}

export function emptySendState(): SendState {
	return { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 };
}

export function planSend(sendState: SendState, context: Context): SendPlan {
	if (!sendState.bootstrapped) {
		return { mode: "bootstrap", resetAgent: false, reason: "initial" };
	}
	const previous = parseFingerprint(sendState.contextFingerprint);
	const current = parseFingerprint(computeContextFingerprint(context));
	if (!previous || !current) {
		return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
	}
	if (current.messageHashes.length < previous.messageHashes.length) {
		return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
	}
	for (let index = 0; index < previous.messageHashes.length; index += 1) {
		if (current.messageHashes[index] !== previous.messageHashes[index]) {
			return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
		}
	}
	const continuation = current.messageHashes.length === previous.messageHashes.length ? { continueOnly: true as const } : {};
	if (current.systemHash !== previous.systemHash) {
		return { mode: "bootstrap", resetAgent: true, reason: "context_divergence", ...continuation };
	}
	if (current.messageHashes.length > previous.messageHashes.length) {
		for (let index = previous.messageHashes.length; index < context.messages.length; index += 1) {
			const role = (context.messages[index] as { role?: string }).role;
			if (role === "branchSummary" || role === "compactionSummary") {
				return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
			}
		}
	}
	if (sendState.incrementalSendCount >= MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP) {
		return { mode: "bootstrap", resetAgent: true, reason: "incremental_threshold", ...continuation };
	}
	return { mode: "incremental", resetAgent: false, reason: "incremental", ...continuation };
}

function parseFingerprint(value: string): { systemHash: string; messageHashes: string[] } | undefined {
	try {
		const parsed = JSON.parse(value) as { format?: unknown; systemHash?: unknown; messageHashes?: unknown };
		if (parsed.format !== NATIVE_HISTORY_FORMAT || typeof parsed.systemHash !== "string" || !Array.isArray(parsed.messageHashes)) return undefined;
		if (!parsed.messageHashes.every((item) => typeof item === "string")) return undefined;
		return { systemHash: parsed.systemHash, messageHashes: parsed.messageHashes };
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function currentInputMessage(context: Context, continueOnly = false): Record<string, unknown> | undefined {
	const message: unknown = context.messages.at(-1);
	return !continueOnly && isRecord(message) && (message.role === "user" || message.role === "developer") ? message : undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				Boolean(block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string"),
		)
		.map((block) => block.text)
		.join("\n");
}

function imagesFromContent(content: unknown): SDKImage[] {
	if (!Array.isArray(content)) return [];
	const images: SDKImage[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "image") continue;
		if (typeof block.data === "string" && typeof block.mimeType === "string") {
			images.push({ data: block.data, mimeType: block.mimeType });
		}
	}
	return images;
}

function historyUnits(messages: Context["messages"], recoveryStart?: number): Context["messages"][] {
	const units: Context["messages"][] = [];
	let unit: Context["messages"] = [];
	const pending = new Set<string>();
	for (const [index, message] of messages.entries()) {
		if ((message.role === "user" || message.role === "developer") && pending.size === 0 && unit.length > 0 && (recoveryStart === undefined || index <= recoveryStart)) {
			units.push(unit);
			unit = [];
		}
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") pending.add(block.id);
			}
		}
		if (message.role === "toolResult") pending.delete(message.toolCallId);
		unit.push(message);
	}
	if (unit.length > 0) units.push(unit);
	return units;
}

function estimatedHistoryTokens(messages: Context["messages"]): number {
	let tokens = messages.length + 1;
	for (const message of messages) {
		const text = JSON.stringify(message, (_key, value: unknown) => {
			if (isRecord(value) && value.type === "image") {
				// Native tool results contain placeholders; recovery attaches their bytes separately.
				if (message.role !== "toolResult") tokens += 4096;
				return { type: "image", mimeType: value.mimeType };
			}
			return value;
		});
		tokens += estimatedTextTokens(text);
	}
	return tokens;
}

function estimatedTextTokens(text: string): number {
	// ponytail: conservative UTF-8 byte estimate, not a tokenizer; use SDK token counting when public.
	return Buffer.byteLength(text, "utf8");
}

function throwContextOverflow(): never {
	throw new Error("Context window exceeded: current input and system instructions exceed the model input budget (conservative estimate)");
}

function inputTextBudget(current: SDKUserMessage, limits: ModelInputLimits): number {
	if (typeof limits.contextWindow !== "number" || typeof limits.maxTokens !== "number" || !Number.isSafeInteger(limits.contextWindow) || !Number.isSafeInteger(limits.maxTokens) || limits.contextWindow <= 0 || limits.maxTokens < 0) {
		throw new Error("Cursor SDK model context/output limits are unknown or invalid");
	}
	// ponytail: 4096/image reserve; SDK image tokens are unpublished.
	// Encoded payload bytes are not tokens.
	const imageReserve = (current.images?.length ?? 0) * 4096;
	return limits.contextWindow - limits.maxTokens - imageReserve - 1024;
}

/**
 * Final user/developer input or an explicit continuation. Never replay an older request or
 * prepend the OMP system prompt.
 */
export function activeUserInput(context: Context, continueOnly = false): SDKUserMessage {
	const message = currentInputMessage(context, continueOnly);
	if (!message) return { text: "Continue the conversation from where it left off." };
	const text = textFromContent(message.content);
	const images = imagesFromContent(message.content);
	if (!text.trim() && images.length === 0) {
		throw new Error("OMP current input has no text or image content");
	}
	return images.length > 0 ? { text, images } : { text };
}

function validateToolResultRecovery(context: Context): number | undefined {
	if (context.messages.at(-1)?.role !== "toolResult") return undefined;
	const units = historyUnits(context.messages);
	const requestIndex = units.slice(0, -1).reduce((count, unit) => count + unit.length, 0);
	if (context.messages[requestIndex]?.role !== "user" && context.messages[requestIndex]?.role !== "developer") {
		throw new Error("Cannot recover Cursor SDK tool results without their initiating user or developer request");
	}
	const pending = new Set<string>();
	for (let index = requestIndex; index < context.messages.length; index += 1) {
		const message = context.messages[index]!;
		if (message.role === "assistant") {
			if (!Array.isArray(message.content) || message.content.some((block) => !isRecord(block))) {
				throw new Error("Cannot recover Cursor SDK history: unsupported or malformed assistant content");
			}
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (!block.id || pending.has(block.id)) {
					throw new Error("Cannot recover Cursor SDK tool results: assistant tool-call IDs are missing or duplicated");
				}
				pending.add(block.id);
			}
		}
		if (message.role === "toolResult" && !pending.delete(message.toolCallId)) {
			throw new Error("Cannot recover Cursor SDK tool results: duplicate or unmatched result ID");
		}
		if (message.role !== "toolResult" && message.role !== "user" && message.role !== "developer") continue;
		const content: unknown = message.content;
		if (message.role !== "toolResult" && typeof content === "string") continue;
		if (!Array.isArray(content) || content.some((block) => !isRecord(block) || (
			block.type === "text" ? typeof block.text !== "string"
				: block.type === "image" ? typeof block.data !== "string" || !block.data.trim() || typeof block.mimeType !== "string" || !/^image\/\S+$/.test(block.mimeType)
					: true
		))) {
			throw new Error("Cannot recover Cursor SDK history: unsupported or malformed text/image content");
		}
	}
	if (pending.size > 0) {
		throw new Error("Cannot recover Cursor SDK tool results: missing results for an assistant tool-call batch");
	}
	return requestIndex;
}

/** Bootstrap instructions stay in the send text; conversation history is imported natively. */
export function prepareSendInput(plan: SendPlan, context: Context, limits: ModelInputLimits): PreparedSendInput {
	const current = activeUserInput(context, plan.continueOnly);
	if (plan.mode === "incremental") {
		if (estimatedTextTokens(current.text) > inputTextBudget(current, limits)) throwContextOverflow();
		return { prompt: current };
	}
	const recoveryStart = validateToolResultRecovery(context);
	const message = currentInputMessage(context, plan.continueOnly);
	const prior = message ? context.messages.slice(0, -1) : context.messages;
	if (recoveryStart !== undefined) {
		current.text = "Continue the initiating request using the recorded tool results. These tool calls have already completed; do not repeat completed actions or retry recorded tool calls. Treat their results as existing evidence and continue with the remaining work.";
		const images: SDKImage[] = [];
		for (let index = recoveryStart; index < context.messages.length; index += 1) {
			const result = context.messages[index]!;
			if (result.role !== "toolResult") continue;
			for (const image of imagesFromContent(result.content)) {
				images.push(image);
				current.text += `\nAttached image ${images.length}: toolCallId=${JSON.stringify(nativeToolCallId(result.toolCallId))}, toolName=${JSON.stringify(result.toolName)}.`;
			}
		}
		if (images.length > 0) current.images = images;
	}
	const sanitized = sanitizeSystemPromptForCursor(serializeSystemPrompt(context.systemPrompt));
	const system = sanitized ? `System instructions from OMP:\n${sanitized}\n\n` : "";
	const budget = inputTextBudget(current, limits);
	let text = system + current.text;
	const requiredTokens = estimatedTextTokens(text);
	if (requiredTokens > budget) throwContextOverflow();
	const units = historyUnits(prior, recoveryStart);
	const toolContext = prior.length > 0 ? `${SDK_TOOL_CONTEXT}\n\n` : "";
	let remaining = budget - requiredTokens - estimatedTextTokens(toolContext);
	let start = units.length;
	while (start > 0) {
		const cost = estimatedHistoryTokens(units[start - 1]!);
		if (cost > remaining) break;
		remaining -= cost;
		start -= 1;
	}
	if (recoveryStart !== undefined && start === units.length) {
		throw new Error("Context window exceeded: required tool recovery history, initiating request, and continuation exceed the model input budget (conservative estimate)");
	}
	if (start < units.length) text = system + toolContext + current.text;
	return {
		prompt: { ...current, text },
		history: structuredClone(units.slice(start).flat()),
	};
}

export function activeUserText(context: Context): string {
	return activeUserInput(context).text;
}
