import { describe, expect, test } from "bun:test";
import { activeUserInput, activeUserText, bootstrapUserInput, computeContextFingerprint, emptySendState, planSend, turnPrompt } from "../../src/context.ts";
import type { Context } from "@oh-my-pi/pi-ai";

function context(messages: Context["messages"], systemPrompt = ["sys"]): Context {
	return { systemPrompt, messages };
}

describe("send policy", () => {
	test("bootstraps the first send", () => {
		const ctx = context([{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number]]);
		expect(planSend(emptySendState(), ctx).mode).toBe("bootstrap");
	});

	test("incrementals when only a user message is appended", () => {
		const first = context([{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number]]);
		const fingerprint = computeContextFingerprint(first);
		const second = context([
			{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number],
			{ role: "user", content: "again", timestamp: 2 } as Context["messages"][number],
		]);
		const plan = planSend({ bootstrapped: true, contextFingerprint: fingerprint, incrementalSendCount: 0 }, second);
		expect(plan).toEqual({ mode: "incremental", resetAgent: false, reason: "incremental" });
	});

	test("rebuilds after a shortened history", () => {
		const first = context([
			{ role: "user", content: "a", timestamp: 1 } as Context["messages"][number],
			{ role: "user", content: "b", timestamp: 2 } as Context["messages"][number],
		]);
		const second = context([{ role: "user", content: "a", timestamp: 1 } as Context["messages"][number]]);
		const plan = planSend(
			{ bootstrapped: true, contextFingerprint: computeContextFingerprint(first), incrementalSendCount: 1 },
			second,
		);
		expect(plan.mode).toBe("bootstrap");
		expect(plan.resetAgent).toBe(true);
	});

	test("sends only the active user text, never the system prompt", () => {
		const ctx = context(
			[{ role: "user", content: "do the work", timestamp: 1 } as Context["messages"][number]],
			["You are an OMP agent with extra instructions."],
		);
		expect(activeUserText(ctx)).toBe("do the work");
		expect(activeUserText(ctx)).not.toContain("OMP agent");
	});

	test("does not fall back to an older user request when the current turn is image-only", () => {
		const ctx = context([
			{ role: "user", content: "Run the old command", timestamp: 1 } as Context["messages"][number],
			{ role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2 } as Context["messages"][number],
			{
				role: "user",
				content: [{ type: "image", data: "abc", mimeType: "image/png" }],
				timestamp: 3,
			} as Context["messages"][number],
		]);
		expect(activeUserInput(ctx)).toEqual({
			text: "",
			images: [{ data: "abc", mimeType: "image/png" }],
		});
	});

	test("bootstraps prior history with the current user request and never copies the system prompt", () => {
		const ctx = context(
			[
				{ role: "user", content: "target is /workspace/important.ts", timestamp: 1 } as Context["messages"][number],
				{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } as Context["messages"][number],
				{ role: "user", content: "continue that edit", timestamp: 3 } as Context["messages"][number],
			],
			["You are an OMP agent with extra instructions."],
		);
		const prompt = bootstrapUserInput(ctx);
		expect(prompt.text).toContain("target is /workspace/important.ts");
		expect(prompt.text).toContain("continue that edit");
		expect(prompt.text).not.toContain("OMP agent");
		expect(turnPrompt({ mode: "incremental", resetAgent: false, reason: "incremental" }, ctx)).toEqual({
			text: "continue that edit",
		});
	});
});
