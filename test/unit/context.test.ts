import { describe, expect, test } from "bun:test";
import { activeUserText, computeContextFingerprint, emptySendState, planSend } from "../../src/context.ts";
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
});
