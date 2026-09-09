import { createHash } from "node:crypto";
import type { SDKImage, SDKUserMessage } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP } from "./constants.js";
import { trailingToolResults } from "./omp-tools.js";

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
	return JSON.stringify({ systemHash, messageHashes });
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
		const parsed = JSON.parse(value) as { systemHash?: unknown; messageHashes?: unknown };
		if (typeof parsed.systemHash !== "string" || !Array.isArray(parsed.messageHashes)) return undefined;
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


function serializeToolCall(block: Record<string, unknown>): string {
	const name = typeof block.name === "string" ? block.name : "tool";
	const id = typeof block.id === "string" ? block.id : typeof block.toolCallId === "string" ? block.toolCallId : "";
	const args = "arguments" in block ? block.arguments : block.args;
	return `toolCall ${name}${id ? ` (${id})` : ""}: ${typeof args === "string" ? args : JSON.stringify(args ?? {})}`;
}

function serializeMessage(message: unknown): string {
	if (!isRecord(message)) return "";
	const role = typeof message.role === "string" ? message.role : "unknown";
	if (role === "toolCall" || role === "toolUse") {
		return serializeToolCall(message);
	}
	if (role === "toolResult") {
		const name = typeof message.toolName === "string" ? message.toolName : "tool";
		const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
		const text = textFromContent(message.content);
		const error = message.isError ? " error" : "";
		return `toolResult ${name}${id ? ` (${id})` : ""}${error}: ${text}`;
	}
	if (role === "user" || role === "developer" || role === "assistant") {
		const lines: string[] = [];
		const text = textFromContent(message.content);
		const images = imagesFromContent(message.content);
		const imageNote = images.length > 0 ? " [image omitted]" : "";
		if (text || images.length > 0) {
			lines.push(`${role}: ${text}${imageNote}`.trimEnd());
		}
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isRecord(block)) continue;
				if (block.type === "toolCall" || block.type === "toolUse") {
					lines.push(serializeToolCall(block));
				}
			}
		}
		return lines.join("\n");
	}
	return `${role}: ${JSON.stringify(message)}`;
}

function historyUnits(messages: readonly unknown[]): string[] {
	const units: string[] = [];
	let lines: string[] = [];
	const pending = new Set<string>();
	for (const message of messages) {
		if (!isRecord(message)) continue;
		if ((message.role === "user" || message.role === "developer") && pending.size === 0 && lines.length > 0) {
			units.push(lines.join("\n"));
			lines = [];
		}
		const blocks = Array.isArray(message.content) ? message.content : [];
		for (const block of [message, ...blocks]) {
			if (!isRecord(block)) continue;
			if (block.type === "toolCall" || block.type === "toolUse" || block.role === "toolCall" || block.role === "toolUse") {
				const id = block.id ?? block.toolCallId;
				if (typeof id === "string") pending.add(id);
			}
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string") pending.delete(message.toolCallId);
		const line = serializeMessage(message);
		if (line) lines.push(line);
	}
	if (lines.length > 0) units.push(lines.join("\n"));
	return units;
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
	// Image accounting is intentionally conservative: reserve at least 4096 tokens per image,
	// or its encoded payload size if larger. SDK image tokenization is not public.
	const imageReserve = current.images?.reduce((sum, image) => sum + Math.max(4096, "data" in image ? estimatedTextTokens(image.data) : 4096), 0) ?? 0;
	const budget = limits.contextWindow - limits.maxTokens - imageReserve - 1024;
	if (budget < 0) throwContextOverflow();
	return budget;
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

function validateToolResultRecovery(context: Context): boolean {
	const results = trailingToolResults(context);
	if (results.length === 0) return false;
	const batchIndex = context.messages.length - results.length - 1;
	const batch = context.messages[batchIndex];
	if (batch?.role !== "assistant") {
		throw new Error("Cannot recover Cursor SDK tool results without their preceding assistant tool-call batch");
	}
	const pending = new Set<string>();
	for (const block of batch.content) {
		if (block.type !== "toolCall") continue;
		if (!block.id || pending.has(block.id)) {
			throw new Error("Cannot recover Cursor SDK tool results: assistant tool-call IDs are missing or duplicated");
		}
		pending.add(block.id);
	}
	for (const result of results) {
		if (!pending.delete(result.toolCallId)) {
			throw new Error("Cannot recover Cursor SDK tool results: duplicate or unmatched result ID");
		}
	}
	if (pending.size > 0) {
		throw new Error("Cannot recover Cursor SDK tool results: missing results for the latest assistant tool-call batch");
	}
	let requestIndex = batchIndex - 1;
	while (requestIndex >= 0) {
		const role = context.messages[requestIndex]!.role;
		if (role === "user" || role === "developer") break;
		requestIndex -= 1;
	}
	if (requestIndex < 0) {
		throw new Error("Cannot recover Cursor SDK tool results without their initiating user or developer request");
	}
	for (let index = requestIndex; index < context.messages.length; index += 1) {
		const message = context.messages[index]!;
		if (message.role === "toolResult" && message.content.some((block) => block.type !== "text")) {
			throw new Error("Cannot recover Cursor SDK non-text tool results from reconstructed text history");
		}
	}
	return true;
}

/**
 * New SDK agent input: sanitized OMP system instructions (when nonempty), prior
 * visible history, then the current input or continuation. Native SDK systemPrompt is never
 * set. Historical images are noted, not re-attached.
 */
export function bootstrapUserInput(context: Context, limits: ModelInputLimits, continueOnly = false): SDKUserMessage {
	const recovering = validateToolResultRecovery(context);
	const message = currentInputMessage(context, continueOnly);
	const prior = message ? context.messages.slice(0, -1) : context.messages;
	const current: SDKUserMessage = recovering
		? { text: "Continue the initiating request using the recorded tool results above. These tool calls have already completed; do not repeat completed actions or retry recorded tool calls. Treat their results as existing evidence and continue with the remaining work." }
		: activeUserInput(context, continueOnly);
	const sanitized = sanitizeSystemPromptForCursor(serializeSystemPrompt(context.systemPrompt));
	const system = sanitized ? `System instructions from OMP:\n${sanitized}\n\n` : "";
	const budget = inputTextBudget(current, limits);
	if (estimatedTextTokens(system + current.text) > budget) throwContextOverflow();
	const units = historyUnits(prior);
	const suffix = `\n\n---\nCurrent ${message?.role === "developer" ? "developer" : message ? "user" : "continuation"} request:\n${current.text}`;
	const header = "Previous OMP conversation (reconstructed context, not live Cursor history):\n";
	let remaining = budget - estimatedTextTokens(system + header + suffix);
	let start = units.length;
	while (start > 0) {
		const cost = estimatedTextTokens(units[start - 1]! + "\n");
		if (cost > remaining) break;
		remaining -= cost;
		start -= 1;
	}
	if (recovering && start === units.length) {
		throw new Error("Context window exceeded: required tool recovery history, initiating request, and continuation exceed the model input budget (conservative estimate)");
	}
	const text = start < units.length ? system + header + units.slice(start).join("\n") + suffix : system + current.text;
	return current.images?.length ? { text, images: current.images } : { text };
}

export function turnPrompt(plan: SendPlan, context: Context, limits: ModelInputLimits): SDKUserMessage {
	if (plan.mode === "bootstrap") return bootstrapUserInput(context, limits, plan.continueOnly);
	const current = activeUserInput(context, plan.continueOnly);
	if (estimatedTextTokens(current.text) > inputTextBudget(current, limits)) throwContextOverflow();
	return current;
}

export function activeUserText(context: Context): string {
	return activeUserInput(context).text;
}
