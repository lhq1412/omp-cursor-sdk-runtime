import { createHash } from "node:crypto";
import type { SDKImage, SDKUserMessage } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP } from "./constants.js";

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
}

function hashValue(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function serializeSystemPrompt(systemPrompt: string | readonly string[] | undefined): string {
	return typeof systemPrompt === "string" ? systemPrompt : systemPrompt?.join("\n") ?? "";
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
	if (sendState.incrementalSendCount >= MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP) {
		return { mode: "bootstrap", resetAgent: true, reason: "incremental_threshold" };
	}
	const previous = parseFingerprint(sendState.contextFingerprint);
	const current = parseFingerprint(computeContextFingerprint(context));
	if (!previous || !current) {
		return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
	}
	if (current.systemHash !== previous.systemHash) {
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
	if (current.messageHashes.length > previous.messageHashes.length) {
		for (let index = previous.messageHashes.length; index < context.messages.length; index += 1) {
			const role = (context.messages[index] as { role?: string }).role;
			if (role === "branchSummary" || role === "compactionSummary") {
				return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
			}
		}
	}
	return { mode: "incremental", resetAgent: false, reason: "incremental" };
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

function lastUserMessage(context: Context): Record<string, unknown> {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index] as { role?: string };
		if (message.role === "user") return message as Record<string, unknown>;
	}
	throw new Error("OMP context has no active user message to send");
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				Boolean(block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string"),
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
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

/**
 * Current user turn only. Never walk back to an older user request, and never
 * prepend the OMP system prompt.
 */
export function activeUserInput(context: Context): SDKUserMessage {
	const message = lastUserMessage(context);
	const text = textFromContent(message.content);
	const images = imagesFromContent(message.content);
	if (!text && images.length === 0) {
		throw new Error("OMP current user message has no text or image content");
	}
	return images.length > 0 ? { text, images } : { text };
}

export function activeUserText(context: Context): string {
	return activeUserInput(context).text;
}
