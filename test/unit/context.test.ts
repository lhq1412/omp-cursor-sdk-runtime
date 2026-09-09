import { describe, expect, test } from "bun:test";
import { activeUserInput, activeUserText, bootstrapUserInput, computeContextFingerprint, emptySendState, planSend, turnPrompt } from "../../src/context.ts";
import type { Context } from "@oh-my-pi/pi-ai";

function context(messages: Context["messages"], systemPrompt: Context["systemPrompt"] = ["sys"]): Context {
	return { systemPrompt, messages };
}

const firstUser = [{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number]];

describe("send policy", () => {
	test("bootstraps the first send with system instructions", () => {
		const ctx = context(firstUser, ["Keep going.", "Be brief."]);
		const plan = planSend(emptySendState(), ctx);
		expect(plan.mode).toBe("bootstrap");
		expect(turnPrompt(plan, ctx).text).toBe("System instructions from OMP:\nKeep going.\nBe brief.\n\nhi");
		expect(bootstrapUserInput(context(firstUser, "")).text).toBe("hi");
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
		expect(turnPrompt(plan, second).text).toBe("again");
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
		expect(turnPrompt(plan, second).text).toBe("System instructions from OMP:\nnew policy\n\nhi");
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
		expect(bootstrapUserInput(ctx).images).toEqual([{ data: "abc", mimeType: "image/png" }]);
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
		const prompt = bootstrapUserInput(ctx);
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
		expect(bootstrapUserInput(ctx).text).toBe(
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
		expect(turnPrompt({ mode: "incremental", resetAgent: false, reason: "incremental" }, ctx)).toEqual({
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
		expect(bootstrapUserInput(context(firstUser, structured)).text).toBe(
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
		expect(bootstrapUserInput(context(firstUser, unmarked)).text).toBe("System instructions from OMP:\nBe terse. Extra.\n\nhi");

		const incomplete = "<system-conventions>\n# Internal URLs\nHOST_CATALOG stays\nno workflow marker";
		expect(bootstrapUserInput(context(firstUser, incomplete)).text).toBe(
			`System instructions from OMP:\n${incomplete}\n\nhi`,
		);
	});
});
