import { createHash } from "node:crypto";
import type { SDKImage, SDKUserMessage } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import {
	BOOTSTRAP_OUTPUT_RESERVE_TOKENS,
	CURSOR_SDK_API,
	CURSOR_SDK_PROVIDER_ID,
	SDK_TOOL_CONTEXT,
} from "./constants.js";
import { CursorBootstrapBudgetError, CursorRecoveryBudgetError } from "./errors.js";
import { nativeToolCallId, projectSdkToolCallId } from "./tool-call-id.js";

export type SendMode = "bootstrap" | "incremental";

export interface SendState {
	bootstrapped: boolean;
	contextFingerprint: string;
	incrementalSendCount: number;
}

export interface SendPlan {
	mode: SendMode;
	resetAgent: boolean;
	reason: "initial" | "context_divergence" | "incremental";
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

export interface MessageLocator {
	role: string;
	timestamp?: number;
	digest: string;
}


const NATIVE_HISTORY_FORMAT = "native-checkpoint-v1";
const CONTEXT_FINGERPRINT_VERSION = 3;
const IMAGE_TOKEN_RESERVE = 4096;

export function registerLegacyCursorToolCallIdMigration(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("context", (event) => {
		const callIds = new Map<string, string>();
		// OMP may only shallow-copy messages when structuredClone fails on details.
		// Never mutate event.messages in place; return a new array of new objects.
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role === "assistant") {
				const cursorOrigin = message.provider === CURSOR_SDK_PROVIDER_ID && message.api === CURSOR_SDK_API;
				let contentChanged = false;
				const content = message.content.map((block) => {
					if (block.type !== "toolCall") return block;
					const id = block.id;
					if (cursorOrigin) {
						const mappedId = projectSdkToolCallId(id);
						if (mappedId !== id) {
							callIds.set(id, mappedId);
							contentChanged = true;
							return { ...block, id: mappedId };
						}
					}
					// A later call with the same raw ID owns subsequent results.
					callIds.delete(id);
					return block;
				});
				if (!contentChanged) return message;
				changed = true;
				return { ...message, content };
			}
			if (message.role === "toolResult") {
				const mappedId = callIds.get(message.toolCallId);
				if (!mappedId) return message;
				changed = true;
				return { ...message, toolCallId: mappedId };
			}
			return message;
		});
		if (!changed) return;
		return { messages };
	});
}

function hashValue(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableMessageParts(message: unknown): { role: string; json: string } {
	const role = isRecord(message) && typeof message.role === "string" ? message.role : "unknown";
	const stable = role === "assistant" && isRecord(message)
		? { ...message, completedAt: undefined, contextSnapshot: undefined }
		: message;
	return { role, json: JSON.stringify(stable) };
}

/** Identity hash for a model-visible message. Omits array index so locators survive compaction. */
export function stableMessageDigest(message: unknown): string {
	const { role, json } = stableMessageParts(message);
	return hashValue(`${role}:${json}`);
}

export function locatorFor(message: unknown): MessageLocator {
	const { role } = stableMessageParts(message);
	const timestamp = isRecord(message) && typeof message.timestamp === "number" ? message.timestamp : undefined;
	return {
		role,
		digest: stableMessageDigest(message),
		...(timestamp !== undefined ? { timestamp } : {}),
	};
}

export function locatorsMatch(left: MessageLocator, right: MessageLocator): boolean {
	if (left.role !== right.role || left.digest !== right.digest) return false;
	if (left.timestamp !== undefined && right.timestamp !== undefined) return left.timestamp === right.timestamp;
	return true;
}


function serializeSystemPrompt(systemPrompt: string | readonly string[] | undefined): string {
	return typeof systemPrompt === "string" ? systemPrompt : systemPrompt?.join("\n") ?? "";
}

export function computeContextFingerprint(context: Context): string {
	const systemHash = hashValue(serializeSystemPrompt(context.systemPrompt));
	const messageCount = context.messages.length;
	const prefixDigest = messagePrefixDigest(context.messages, messageCount);
	return JSON.stringify({
		format: NATIVE_HISTORY_FORMAT,
		formatVersion: CONTEXT_FINGERPRINT_VERSION,
		systemHash,
		messageCount,
		prefixDigest,
	});
}

function messagePrefixDigest(messages: Context["messages"], messageCount: number): string {
	const hash = createHash("sha256");
	for (let index = 0; index < messageCount; index += 1) {
		const message = messages[index]!;
		const { role, json } = stableMessageParts(message);
		hash.update(String(index));
		hash.update("\0");
		hash.update(role);
		hash.update("\0");
		hash.update(json);
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function emptySendState(): SendState {
	return { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 };
}

export function planSend(sendState: SendState, context: Context): SendPlan {
	if (!sendState.bootstrapped) {
		return { mode: "bootstrap", resetAgent: false, reason: "initial" };
	}
	const previous = parseFingerprint(sendState.contextFingerprint);
	if (!previous) {
		return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
	}
	if (context.messages.length < previous.messageCount) {
		return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
	}
	if ("prefixDigest" in previous) {
		if (messagePrefixDigest(context.messages, previous.messageCount) !== previous.prefixDigest) {
			return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
		}
	} else {
		for (let index = 0; index < previous.messageCount; index += 1) {
			const message = context.messages[index]!;
			const { role, json } = stableMessageParts(message);
			if (previous.messageHashes[index] !== hashValue(`${index}:${role}:${json}`)
				&& previous.messageHashes[index] !== hashValue(`${index}:${message.role}:${JSON.stringify(message)}`)) {
				return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
			}
		}
	}
	const continuation = context.messages.length === previous.messageCount ? { continueOnly: true as const } : {};
	// Old formats can prove input was consumed, but never authorize agent reuse.
	if (!previous.reusable || hashValue(serializeSystemPrompt(context.systemPrompt)) !== previous.systemHash) {
		return { mode: "bootstrap", resetAgent: true, reason: "context_divergence", ...continuation };
	}
	if (context.messages.length > previous.messageCount) {
		if (suffixRequiresBootstrap(context.messages, previous.messageCount)) {
			return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
		}
	}
	return { mode: "incremental", resetAgent: false, reason: "incremental", ...continuation };
}

type ParsedFingerprint = {
	systemHash: string;
	messageCount: number;
	reusable: boolean;
} & ({ prefixDigest: string } | { messageHashes: string[] });

function parseFingerprint(value: string): ParsedFingerprint | undefined {
	try {
		const parsed = JSON.parse(value) as {
			format?: unknown;
			formatVersion?: unknown;
			systemHash?: unknown;
			messageCount?: unknown;
			prefixDigest?: unknown;
			messageHashes?: unknown;
		};
		if (parsed.format !== NATIVE_HISTORY_FORMAT || typeof parsed.systemHash !== "string") return undefined;
		if (parsed.formatVersion === CONTEXT_FINGERPRINT_VERSION || parsed.formatVersion === 2) {
			if (
				!Number.isSafeInteger(parsed.messageCount)
				|| (parsed.messageCount as number) < 0
				|| typeof parsed.prefixDigest !== "string"
			) return undefined;
			return {
				systemHash: parsed.systemHash,
				messageCount: parsed.messageCount as number,
				prefixDigest: parsed.prefixDigest,
				reusable: parsed.formatVersion === CONTEXT_FINGERPRINT_VERSION,
			};
		}
		if (
			parsed.formatVersion !== undefined
			|| !Array.isArray(parsed.messageHashes)
			|| !parsed.messageHashes.every((item) => typeof item === "string")
		) return undefined;
		return {
			systemHash: parsed.systemHash,
			messageCount: parsed.messageHashes.length,
			messageHashes: parsed.messageHashes,
			reusable: false,
		};
	} catch {
		return undefined;
	}
}

function suffixRequiresBootstrap(messages: Context["messages"], fromIndex: number): boolean {
	let extraTurns = 0;
	for (let index = fromIndex; index < messages.length; index += 1) {
		const message = messages[index];
		if (!isRecord(message) || typeof message.role !== "string") return true;
		if (message.role === "user" || message.role === "developer") {
			extraTurns += 1;
			if (extraTurns > 1) return true;
			continue;
		}
		if (message.role === "assistant") {
			if (message.provider !== CURSOR_SDK_PROVIDER_ID || message.api !== CURSOR_SDK_API) return true;
			continue;
		}
		if (message.role === "toolResult") continue;
		return true;
	}
	return false;
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

function nativeToolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((item) => {
		if (!isRecord(item)) return "";
		if (item.type === "text" && typeof item.text === "string") return item.text;
		if (item.type === "image" && typeof item.mimeType === "string") return `[${item.mimeType} image]`;
		return "";
	}).join("\n");
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

function historyUnits(messages: Context["messages"]): Context["messages"][] {
	const units: Context["messages"][] = [];
	let unit: Context["messages"] = [];
	const pending = new Set<string>();
	for (const message of messages) {
		if ((message.role === "user" || message.role === "developer") && pending.size === 0 && unit.length > 0) {
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


function canReplayNativeThinking(message: { api?: unknown; provider?: unknown; model?: unknown }, targetModelId: string | undefined): boolean {
	// Mirror canReplayCursorThinking in the pinned codec. Do not relabel cursor-sdk identity.
	return (
		targetModelId !== undefined &&
		classifyModel("cursor", targetModelId).family === "k3" &&
		message.api === "cursor-agent" &&
		message.provider === "cursor" &&
		message.model === targetModelId
	);
}

function estimatedHistoryTokens(messages: Context["messages"], targetModelId?: string): number {
	const fragments: string[] = [];
	let tokens = 0;
	for (const message of messages) {
		if (message.role === "user" || message.role === "developer") {
			const text = textFromContent(message.content).trim();
			const images = imagesFromContent(message.content);
			tokens += images.length * IMAGE_TOKEN_RESERVE;
			const content: unknown[] = [];
			if (text) content.push({ type: "text", text });
			for (const image of images) content.push({ type: "image", mediaType: "mimeType" in image ? image.mimeType : "image/png" });
			if (content.length > 0) fragments.push(JSON.stringify({ role: "user", content }));
			continue;
		}
		if (message.role === "assistant") {
			if (!Array.isArray(message.content)) continue;
			const content: unknown[] = [];
			const replayThinking = canReplayNativeThinking(message, targetModelId);
			for (const block of message.content) {
				if (!isRecord(block)) continue;
				if (block.type === "text" && typeof block.text === "string" && block.text) content.push({ type: "text", text: block.text });
				else if (block.type === "thinking" && replayThinking && typeof block.thinking === "string" && block.thinking) {
					content.push({
						type: "reasoning",
						text: block.thinking,
						providerOptions: { cursor: { modelName: message.model } },
						...(typeof block.thinkingSignature === "string" ? { signature: block.thinkingSignature } : {}),
					});
				} else if (block.type === "toolCall" && typeof block.id === "string") {
					content.push({
						type: "tool-call",
						toolCallId: nativeToolCallId(block.id),
						toolName: typeof block.name === "string" ? block.name : "",
						args: block.arguments ?? {},
					});
				}
			}
			if (content.length > 0) fragments.push(JSON.stringify({ role: "assistant", content }));
			continue;
		}
		if (message.role === "toolResult") {
			const toolCallId = nativeToolCallId(message.toolCallId);
			fragments.push(JSON.stringify({
				role: "tool",
				id: toolCallId,
				content: [{
					type: "tool-result",
					toolName: message.toolName,
					toolCallId,
					result: nativeToolResultText(message.content),
					...(message.isError ? { isError: true } : {}),
				}],
			}));
			continue;
		}
		const extra = message as { role?: string; summary?: unknown };
		if ((extra.role === "compactionSummary" || extra.role === "branchSummary") && typeof extra.summary === "string" && extra.summary) {
			fragments.push(extra.summary);
		}
	}
	for (const fragment of fragments) tokens += estimatedTextTokens(fragment);
	return tokens;
}

function estimatedTextTokens(text: string): number {
	// ponytail: OMP Tokenizer approximate; use a model tokenizer when this adapter owns one.
	return (Buffer.byteLength(text, "utf8") + 3) >> 2;
}

function throwContextOverflow(): never {
	throw new Error("Context window exceeded: current input and system instructions exceed the model input budget (conservative estimate)");
}

function inputTextBudget(current: SDKUserMessage, limits: ModelInputLimits): number {
	if (typeof limits.contextWindow !== "number" || typeof limits.maxTokens !== "number" || !Number.isSafeInteger(limits.contextWindow) || !Number.isSafeInteger(limits.maxTokens) || limits.contextWindow <= 0 || limits.maxTokens < 0) {
		throw new Error("Cursor SDK model context/output limits are unknown or invalid");
	}
	// ponytail: 4096/image reserve; SDK image tokens are unpublished.
	// Encoded payload bytes are not tokens. Advertised maxTokens is not the bootstrap reserve.
	const imageReserve = (current.images?.length ?? 0) * IMAGE_TOKEN_RESERVE;
	return limits.contextWindow - Math.min(limits.maxTokens, BOOTSTRAP_OUTPUT_RESERVE_TOKENS) - imageReserve - 1024;
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
export function prepareSendInput(
	plan: SendPlan,
	context: Context,
	limits: ModelInputLimits,
	targetModelId?: string,
	toolGuidance = "",
	formalToolDefinitionReserveTokens = 0,
): PreparedSendInput {
	const current = activeUserInput(context, plan.continueOnly);
	const definitionReserve = Math.max(0, formalToolDefinitionReserveTokens);
	if (plan.mode === "incremental") {
		if (estimatedTextTokens(current.text) + definitionReserve > inputTextBudget(current, limits)) throwContextOverflow();
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
	const systemText = serializeSystemPrompt(context.systemPrompt).trim();
	const system = systemText ? `System instructions from OMP:\n${systemText}\n\n` : "";
	const tools = toolGuidance ? `${toolGuidance}\n\n` : "";
	const toolContext = prior.length > 0 ? `${SDK_TOOL_CONTEXT}\n\n` : "";
	const budget = inputTextBudget(current, limits);
	const requiredText = system + tools + toolContext + current.text;
	if (estimatedTextTokens(requiredText) + definitionReserve > budget) {
		if (recoveryStart !== undefined) throw new CursorRecoveryBudgetError();
		throwContextOverflow();
	}
	const text = requiredText;
	if (estimatedTextTokens(text) + estimatedHistoryTokens(prior, targetModelId) + definitionReserve > budget) {
		if (recoveryStart !== undefined) throw new CursorRecoveryBudgetError();
		throw new CursorBootstrapBudgetError();
	}
	return {
		prompt: { ...current, text },
		history: structuredClone(prior),
	};
}

export function activeUserText(context: Context): string {
	return activeUserInput(context).text;
}
