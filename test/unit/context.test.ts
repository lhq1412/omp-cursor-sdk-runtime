import { describe, expect, test } from "bun:test";
import { activeUserInput, activeUserText, bootstrapUserInput, computeContextFingerprint, emptySendState, planSend, turnPrompt } from "../../src/context.ts";
import type { Context } from "@oh-my-pi/pi-ai";

const modelLimits = { contextWindow: 200_000, maxTokens: 20_000 };

function context(messages: Context["messages"], systemPrompt: Context["systemPrompt"] = ["sys"]): Context {
	return { systemPrompt, messages };
}

const firstUser = [{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number]];

describe("send policy", () => {
	test("bootstraps the first send with system instructions", () => {
		const ctx = context(firstUser, ["Keep going.", "Be brief."]);
		const plan = planSend(emptySendState(), ctx);
		expect(plan.mode).toBe("bootstrap");
		expect(turnPrompt(plan, ctx, modelLimits).text).toBe("System instructions from OMP:\nKeep going.\nBe brief.\n\nhi");
		expect(bootstrapUserInput(context(firstUser, ""), modelLimits).text).toBe("hi");
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
		expect(turnPrompt(plan, second, modelLimits).text).toBe("again");
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

	test("rebuilds after the system prompt changes", () => {
		const first = context(firstUser, "old policy");
		const second = context(firstUser, "new policy");
		const plan = planSend(
			{ bootstrapped: true, contextFingerprint: computeContextFingerprint(first), incrementalSendCount: 1 },
			second,
		);
		expect(plan.mode).toBe("bootstrap");
		expect(plan.resetAgent).toBe(true);
		const prompt = turnPrompt(plan, second, modelLimits).text;
		expect(prompt).toContain("new policy");
		expect(prompt).toContain("user: hi");
		expect(prompt).toContain("Current continuation request:");
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
		expect(bootstrapUserInput(ctx, modelLimits).images).toEqual([{ data: "abc", mimeType: "image/png" }]);
	});

	test("bootstraps assistant.content toolCall blocks with name, id, arguments, and later toolResult", () => {
		const ctx = context([
			{ role: "user", content: "run the listing", timestamp: 1 } as Context["messages"][number],
			{
				role: "assistant",
				content: [
					{ type: "text", text: "listing files" },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la" } },
				],
				timestamp: 2,
			} as Context["messages"][number],
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "a.ts" }],
				isError: false,
				timestamp: 3,
			} as Context["messages"][number],
			{ role: "user", content: "continue", timestamp: 4 } as Context["messages"][number],
		]);
		const prompt = bootstrapUserInput(ctx, modelLimits);
		expect(prompt.text).toContain("toolCall bash (call-1)");
		expect(prompt.text).toContain("ls -la");
		expect(prompt.text).toContain("toolResult bash (call-1): a.ts");
		expect(prompt.text).toContain("continue");
		expect(prompt.text).not.toMatch(/role":"toolCall"/);
	});

	test("bootstraps history and system instructions; incrementals send the current user only", () => {
		const ctx = context(
			[
				{ role: "user", content: "target is /workspace/important.ts", timestamp: 1 } as Context["messages"][number],
				{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } as Context["messages"][number],
				{ role: "user", content: "continue that edit", timestamp: 3 } as Context["messages"][number],
			],
			["You are an OMP agent with extra instructions."],
		);
		expect(bootstrapUserInput(ctx, modelLimits).text).toBe(
			[
				"System instructions from OMP:",
				"You are an OMP agent with extra instructions.",
				"",
				"Previous OMP conversation (reconstructed context, not live Cursor history):",
				"user: target is /workspace/important.ts",
				"assistant: ok",
				"",
				"---",
				"Current user request:",
				"continue that edit",
			].join("\n"),
		);
		expect(turnPrompt({ mode: "incremental", resetAgent: false, reason: "incremental" }, ctx, modelLimits)).toEqual({
			text: "continue that edit",
		});
	});

	test("sanitizes structured OMP prompts and falls back when markers are absent", () => {
		const structured = [
			"<system-conventions>",
			"Stay in this prefix.",
			"# Internal URLs",
			"HOST_CATALOG must vanish",
			"§ Workflow",
			"Keep this workflow.",
		].join("\n");
		expect(bootstrapUserInput(context(firstUser, structured), modelLimits).text).toBe(
			[
				"System instructions from OMP:",
				"<system-conventions>",
				"Stay in this prefix.",
				"",
				"OMP host tool catalog and tool policy omitted: Cursor can call only Cursor SDK tools exposed in this run.",
				"",
				"§ Workflow",
				"Keep this workflow.",
				"",
				"hi",
			].join("\n"),
		);

		const unmarked = "  Be terse. Extra.  ";
		expect(bootstrapUserInput(context(firstUser, unmarked), modelLimits).text).toBe("System instructions from OMP:\nBe terse. Extra.\n\nhi");

		const incomplete = "<system-conventions>\n# Internal URLs\nHOST_CATALOG stays\nno workflow marker";
		expect(bootstrapUserInput(context(firstUser, incomplete), modelLimits).text).toBe(
			`System instructions from OMP:\n${incomplete}\n\nhi`,
		);
	});
	test("uses the final developer instruction including images instead of an earlier user", () => {
		const ctx = context([
			...firstUser,
			{ role: "developer", content: [{ type: "text", text: "  New instruction\n" }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 2 },
		]);
		expect(activeUserInput(ctx)).toEqual({ text: "  New instruction\n", images: [{ data: "abc", mimeType: "image/png" }] });
		const prompt = bootstrapUserInput(ctx, modelLimits);
		expect(prompt.text).toContain("Current developer request:\n  New instruction\n");
		expect(prompt.images).toEqual([{ data: "abc", mimeType: "image/png" }]);
	});

	test("continues without replaying old input when no final input exists", () => {
		const empty = activeUserInput(context([]));
		const completed = context([
			...firstUser,
			{ role: "assistant", content: [{ type: "text", text: "Already finished" }], timestamp: 2 } as Context["messages"][number],
		]);
		expect(activeUserInput(completed)).toEqual(empty);
		expect(empty.text).toMatch(/continue/i);
		expect(empty.text).not.toContain("hi");
		expect(bootstrapUserInput(completed, modelLimits).text).toContain("Already finished");
	});

	test("identical committed input continues even when a periodic bootstrap is due", () => {
		const ctx = context(firstUser);
		for (const incrementalSendCount of [0, 1000]) {
			const plan = planSend({ bootstrapped: true, contextFingerprint: computeContextFingerprint(ctx), incrementalSendCount }, ctx);
			const prompt = turnPrompt(plan, ctx, modelLimits).text;
			expect(prompt).not.toBe("hi");
			expect(prompt).toMatch(/continue/i);
			if (plan.mode === "bootstrap") expect(prompt).toContain("Current continuation request:");
		}
	});

	test("trims oldest interaction units without splitting tool calls across injected developer input", () => {
		const ctx = context([
			{ role: "user", content: "OLD " + "x".repeat(3000), timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "read", arguments: {} }], timestamp: 2 },
			{ role: "developer", content: "injected policy", timestamp: 3 },
			{ role: "toolResult", toolCallId: "old-call", toolName: "read", content: [{ type: "text", text: "old-result" }], timestamp: 4 },
			{ role: "user", content: "RECENT", timestamp: 5 },
			{ role: "assistant", content: [{ type: "toolCall", id: "recent-call", name: "read", arguments: {} }], timestamp: 6 },
			{ role: "toolResult", toolCallId: "recent-call", toolName: "read", content: [{ type: "text", text: "recent-result" }], timestamp: 7 },
			{ role: "user", content: "CURRENT", timestamp: 8 },
		] as Context["messages"], "required system");
		const prompt = bootstrapUserInput(ctx, { contextWindow: 2200, maxTokens: 200 }).text;
		expect(prompt).not.toContain("OLD");
		expect(prompt).not.toContain("old-call");
		expect(prompt).not.toContain("old-result");
		expect(prompt).not.toContain("injected policy");
		expect(prompt).toContain("RECENT");
		expect(prompt).toContain("toolCall read (recent-call)");
		expect(prompt).toContain("toolResult read (recent-call): recent-result");
		expect(prompt).toContain("required system");
		expect(prompt).toContain("CURRENT");
	});

	test("recovery trims older turns but keeps the initiating request and all completed batches", () => {
		const ctx = context([
			{ role: "user", content: "OBSOLETE " + "x".repeat(5000), timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "Old answer" }], timestamp: 2 },
			{ role: "user", content: "Compare a.ts and b.ts", timestamp: 3 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } }], timestamp: 4 },
			{ role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "contents of a.ts" }], timestamp: 5 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } }], timestamp: 6 },
			{ role: "toolResult", toolCallId: "call-b", toolName: "read", content: [{ type: "text", text: "contents of b.ts" }], timestamp: 7 },
		] as Context["messages"], "required system");
		const prompt = bootstrapUserInput(ctx, { contextWindow: 2400, maxTokens: 200 }).text;
		expect(prompt).not.toContain("OBSOLETE");
		expect(prompt).toContain("required system");
		expect(prompt).toContain("Compare a.ts and b.ts");
		expect(prompt).toContain("toolCall read (call-a)");
		expect(prompt).toContain("toolResult read (call-a): contents of a.ts");
		expect(prompt).toContain("toolCall read (call-b)");
		expect(prompt).toContain("toolResult read (call-b): contents of b.ts");
		expect(prompt).toContain("Current continuation request:");
		expect(prompt).not.toContain("Current user request:");
	});

	test("reserves output and images and fails rather than truncating required input", () => {
		const limits = { contextWindow: 6000, maxTokens: 500 };
		const ctx = context([{ role: "user", content: "x".repeat(1000), timestamp: 1 }], "required system");
		expect(bootstrapUserInput(ctx, limits).text).toContain("x".repeat(1000));
		expect(() => bootstrapUserInput(ctx, { ...limits, maxTokens: 5000 })).toThrow(/context window exceeded/i);
		expect(() => bootstrapUserInput({ ...ctx, systemPrompt: ["s".repeat(6000)] }, limits)).toThrow(/context window exceeded/i);
		const withImage = context([{ role: "user", content: [{ type: "text", text: "x".repeat(1000) }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 }]);
		expect(() => bootstrapUserInput(withImage, limits)).toThrow(/context window exceeded/i);
	});
});
