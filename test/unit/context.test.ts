import { describe, expect, test } from "bun:test";
import { SDK_TOOL_CONTEXT } from "../../src/constants.ts";
import { activeUserInput, activeUserText, computeContextFingerprint, emptySendState, planSend, prepareSendInput, registerLegacyCursorToolCallIdMigration, type ModelInputLimits } from "../../src/context.ts";
import { CursorBootstrapBudgetError, CursorRecoveryBudgetError } from "../../src/errors.ts";
import type { ModelSelection } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { normalizeToolCallId } from "@oh-my-pi/pi-ai/utils";
import { buildNativeHistory } from "../../src/native-history.ts";

const modelLimits = { contextWindow: 200_000, maxTokens: 20_000 };

function context(messages: Context["messages"], systemPrompt: Context["systemPrompt"] = ["sys"]): Context {
	return { systemPrompt, messages };
}

function bootstrap(ctx: Context, limits: ModelInputLimits = modelLimits, targetModelId?: string) {
	return prepareSendInput(planSend(emptySendState(), ctx), ctx, limits, targetModelId);
}

const firstUser = [{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number]];

describe("send policy", () => {
	test("bootstraps the first send with system instructions", () => {
		const ctx = context(firstUser, ["Keep going.", "Be brief."]);
		const plan = planSend(emptySendState(), ctx);
		expect(plan.mode).toBe("bootstrap");
		expect(prepareSendInput(plan, ctx, modelLimits)).toEqual({
			prompt: { text: "System instructions from OMP:\nKeep going.\nBe brief.\n\nhi" },
			history: [],
		});
		expect(bootstrap(context(firstUser, "")).prompt.text).toBe("hi");
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
		expect(prepareSendInput(plan, second, modelLimits)).toEqual({ prompt: { text: "again" } });
	});

	test("bootstraps after a foreign-provider suffix", () => {
		const cursorAssistant = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "cursor-sdk-agent",
			provider: "cursor-sdk",
			model: "composer-2.5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		} as Context["messages"][number];
		const first = context([
			{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number],
			cursorAssistant,
		]);
		const second = context([
			...first.messages,
			{ role: "user", content: "ask claude", timestamp: 3 } as Context["messages"][number],
			{
				role: "assistant",
				content: [{ type: "text", text: "claude" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 4,
			} as Context["messages"][number],
			{ role: "user", content: "back to cursor", timestamp: 5 } as Context["messages"][number],
		]);
		expect(planSend({ bootstrapped: true, contextFingerprint: computeContextFingerprint(first), incrementalSendCount: 0 }, second)).toEqual({
			mode: "bootstrap", resetAgent: true, reason: "context_divergence",
		});
	});

	test("stays incremental after a cursor-sdk assistant plus current user", () => {
		const first = context([
			{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number],
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "cursor-sdk-agent",
				provider: "cursor-sdk",
				model: "composer-2.5",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			} as Context["messages"][number],
		]);
		const second = context([
			...first.messages,
			{ role: "user", content: "again", timestamp: 3 } as Context["messages"][number],
		]);
		expect(planSend({ bootstrapped: true, contextFingerprint: computeContextFingerprint(first), incrementalSendCount: 0 }, second)).toEqual({
			mode: "incremental", resetAgent: false, reason: "incremental",
		});
	});

	test("ignores host completion metadata added after a tool continuation", () => {
		const toolUse = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
			api: "cursor-sdk-agent",
			provider: "cursor-sdk",
			model: "composer-2.5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 2,
		} as Context["messages"][number];
		const first = context([
			{ role: "user", content: "inspect", timestamp: 1 } as Context["messages"][number],
			toolUse,
			{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 },
		]);
		const fingerprint = computeContextFingerprint(first);
		Object.assign(toolUse, {
			completedAt: 4,
			contextSnapshot: { promptTokens: 0, nonMessageTokens: 24_056, compactionEpoch: 0 },
		});
		const second = context([
			...first.messages,
			{ role: "user", content: "continue", timestamp: 5 } as Context["messages"][number],
		]);
		expect(planSend({ bootstrapped: true, contextFingerprint: fingerprint, incrementalSendCount: 0 }, second)).toEqual({
			mode: "incremental", resetAgent: false, reason: "incremental",
		});
	});

	test("old v2 and unversioned fingerprints force a fresh bootstrap", () => {
		const prompt = "<system-conventions>\n# Internal URLs\nHOST_CATALOG\n§ Workflow\nkeep";
		const ctx = context([
			{ role: "assistant", content: [{ type: "text", text: "Prior answer" }], timestamp: 1 },
			{ role: "user", content: "Already executed request", timestamp: 3 },
		] as Context["messages"], prompt);
		const current = JSON.parse(computeContextFingerprint(ctx)) as { format: string; systemHash: string };
		const v2 = { ...JSON.parse(computeContextFingerprint(ctx)), formatVersion: 2 };
		const legacy = {
			format: current.format,
			systemHash: current.systemHash,
			messageHashes: ctx.messages.map((message, index) =>
				new Bun.CryptoHasher("sha256").update(`${index}:${message.role}:${JSON.stringify(message)}`).digest("hex").slice(0, 16),
			),
		};
		const flattened = JSON.parse(computeContextFingerprint(ctx)) as Record<string, unknown>;
		delete flattened.format;
		for (const fingerprint of [v2, legacy, flattened]) {
			const plan = planSend({
				bootstrapped: true,
				contextFingerprint: JSON.stringify(fingerprint),
				incrementalSendCount: 20_000,
			}, ctx);
			expect(plan).toEqual({ mode: "bootstrap", resetAgent: true, reason: "context_divergence" });
			const prepared = prepareSendInput(plan, ctx, modelLimits);
			expect(prepared.history).toEqual(ctx.messages.slice(0, -1));
			expect(prepared.prompt.text).toContain(prompt);
			expect(prepared.prompt.text).toContain(SDK_TOOL_CONTEXT);
			expect(prepared.prompt.text).toContain("Already executed request");
			expect(prepared.prompt.text).not.toContain("Prior answer");
		}
		expect(planSend({
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(ctx),
			incrementalSendCount: 20_000,
		}, ctx)).toMatchObject({ mode: "incremental", resetAgent: false, continueOnly: true });
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
		const prepared = prepareSendInput(plan, second, modelLimits);
		expect(prepared.prompt.text).toContain("new policy");
		expect(prepared.history).toEqual(firstUser);
		expect(prepared.prompt.text).toEndWith(activeUserInput(second, true).text);
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
		expect(bootstrap(ctx).prompt.images).toEqual([{ data: "abc", mimeType: "image/png" }]);
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
		const prepared = bootstrap(ctx);
		expect(prepared.history).toEqual(ctx.messages.slice(0, -1));
		expect(prepared.prompt.text).toEndWith("\n\ncontinue");
		expect(prepared.prompt.text).not.toContain("ls -la");
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
		const prepared = bootstrap(ctx);
		expect(prepared.history).toEqual(ctx.messages.slice(0, -1));
		expect(prepared.prompt.text).toBe(`System instructions from OMP:\nYou are an OMP agent with extra instructions.\n\n${SDK_TOOL_CONTEXT}\n\ncontinue that edit`);
		expect(prepared.prompt.text).not.toContain("/workspace/important.ts");
		expect(prepareSendInput({ mode: "incremental", resetAgent: false, reason: "incremental" }, ctx, modelLimits)).toEqual({
			prompt: { text: "continue that edit" },
		});
	});

	test("includes supplied tool guidance only on bootstrap sends", () => {
		const guidance = "OMP custom tool contract: granted tools listed here.";
		const first = context(firstUser, ["Keep going."]);
		const boot = prepareSendInput(planSend(emptySendState(), first), first, modelLimits, undefined, guidance);
		expect(boot.prompt.text).toContain(guidance);
		expect(boot.prompt.text).toContain("System instructions from OMP:\nKeep going.");
		expect(boot.prompt.text).toEndWith("\n\nhi");

		const continued = context([
			{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number],
			{ role: "user", content: "again", timestamp: 2 } as Context["messages"][number],
		]);
		const incremental = prepareSendInput(
			{ mode: "incremental", resetAgent: false, reason: "incremental" },
			continued,
			modelLimits,
			undefined,
			guidance,
		);
		expect(incremental.prompt.text).toBe("again");
		expect(incremental.prompt.text).not.toContain(guidance);
		expect(incremental.prompt.text).not.toContain(SDK_TOOL_CONTEXT);
	});

	test("preserves the joined OMP prompt and only trims outer whitespace", () => {
		const structured = [
			"<system-conventions>",
			"Stay in this prefix.",
			"# Internal URLs",
			"HOST_CATALOG must remain",
			"§ Workflow",
			"Keep this workflow.",
		].join("\n");
		const text = bootstrap(context(firstUser, structured)).prompt.text;
		expect(text).toBe(`System instructions from OMP:\n${structured}\n\nhi`);
		expect(bootstrap(context(firstUser, "  Be terse. Extra.  ")).prompt.text).toBe(
			"System instructions from OMP:\nBe terse. Extra.\n\nhi",
		);
		expect(bootstrap(context(firstUser, "  \n  ")).prompt.text).toBe("hi");
		const incomplete = "<system-conventions>\n# Internal URLs\nHOST_CATALOG stays\nno workflow marker";
		expect(bootstrap(context(firstUser, incomplete)).prompt.text).toContain(incomplete);

		const padded = context(firstUser, "  policy  ");
		const trimmed = context(firstUser, "policy");
		expect(bootstrap(padded).prompt.text).toBe(bootstrap(trimmed).prompt.text);
		expect(computeContextFingerprint(padded)).not.toBe(computeContextFingerprint(trimmed));

		const changed = context(firstUser, structured.replace("HOST_CATALOG must remain", "HOST_CATALOG changed"));
		expect(bootstrap(changed).prompt.text).toContain("HOST_CATALOG changed");
		expect(planSend({
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(context(firstUser, structured)),
			incrementalSendCount: 0,
		}, changed)).toEqual({
			mode: "bootstrap", resetAgent: true, reason: "context_divergence", continueOnly: true,
		});
		expect(prepareSendInput(
			{ mode: "incremental", resetAgent: false, reason: "incremental" },
			context(firstUser, structured),
			modelLimits,
		).prompt.text).toBe("hi");

		const withHistory = context([
			{ role: "user", content: "earlier", timestamp: 1 } as Context["messages"][number],
			{ role: "user", content: "now", timestamp: 2 } as Context["messages"][number],
		], structured);
		const prepared = bootstrap(withHistory);
		expect(prepared.history).toEqual(withHistory.messages.slice(0, -1));
		expect(prepared.prompt.text).toBe(`System instructions from OMP:\n${structured}\n\n${SDK_TOOL_CONTEXT}\n\nnow`);
		expect(prepared.prompt.text).not.toContain("earlier");

		const bulky = `<system-conventions>\nprefix\n# Internal URLs\n${"x".repeat(20_000)}\n§ Workflow\nkeep`;
		expect(() => bootstrap(context(firstUser, bulky), { contextWindow: 6000, maxTokens: 500 })).toThrow(/context window exceeded/i);
	});
	test("uses the final developer instruction including images instead of an earlier user", () => {
		const ctx = context([
			...firstUser,
			{ role: "developer", content: [{ type: "text", text: "  New instruction\n" }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 2 },
		]);
		expect(activeUserInput(ctx)).toEqual({ text: "  New instruction\n", images: [{ data: "abc", mimeType: "image/png" }] });
		const prepared = bootstrap(ctx);
		expect(prepared.history).toEqual(firstUser);
		expect(prepared.prompt.text).toEndWith("  New instruction\n");
		expect(prepared.prompt.images).toEqual([{ data: "abc", mimeType: "image/png" }]);
	});

	test("continues without replaying old input when no final input exists", () => {
		const empty = activeUserInput(context([]));
		const completed = context([
			...firstUser,
			{ role: "assistant", content: [{ type: "text", text: "Already finished" }], timestamp: 2 } as Context["messages"][number],
		]);
		expect(activeUserInput(completed)).toEqual(empty);
		expect(empty.text).not.toContain("hi");
		const prepared = bootstrap(completed);
		expect(prepared.history).toEqual(completed.messages);
		expect(prepared.prompt.text).not.toContain("Already finished");
	});

	test("identical committed input stays incremental regardless of the recorded send count", () => {
		const ctx = context(firstUser);
		for (const incrementalSendCount of [0, 19, 20, 20_000]) {
			const plan = planSend({ bootstrapped: true, contextFingerprint: computeContextFingerprint(ctx), incrementalSendCount }, ctx);
			const prepared = prepareSendInput(plan, ctx, modelLimits);
			expect(prepared.prompt.text).toEndWith(activeUserInput(ctx, true).text);
			expect(plan).toMatchObject({ mode: "incremental", resetAgent: false, continueOnly: true });
			expect(prepared.history).toBeUndefined();
		}
	});

	test("refuses to bootstrap when the complete history does not fit", () => {
		const ctx = context([
			{ role: "user", content: "OLD " + "x".repeat(8000), timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "read", arguments: {} }], timestamp: 2 },
			{ role: "developer", content: "injected policy", timestamp: 3 },
			{ role: "toolResult", toolCallId: "old-call", toolName: "read", content: [{ type: "text", text: "old-result" }], timestamp: 4 },
			{ role: "user", content: "RECENT", timestamp: 5 },
			{ role: "assistant", content: [{ type: "toolCall", id: "recent-call", name: "read", arguments: {} }], timestamp: 6 },
			{ role: "toolResult", toolCallId: "recent-call", toolName: "read", content: [{ type: "text", text: "recent-result" }], timestamp: 7 },
			{ role: "user", content: "CURRENT", timestamp: 8 },
		] as Context["messages"], "required system");
		expect(() => bootstrap(ctx, { contextWindow: 2200, maxTokens: 200 })).toThrow(CursorBootstrapBudgetError);
		expect(() => bootstrap(ctx, { contextWindow: 2200, maxTokens: 200 })).toThrow(/\/compact/);
	});

	test("recovery refuses to omit an oversized prefix before the initiating request", () => {
		const ctx = context([
			{ role: "user", content: "OBSOLETE " + "x".repeat(20_000), timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "Old answer" }], timestamp: 2 },
			{ role: "user", content: "Compare a.ts and b.ts", timestamp: 3 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } }], timestamp: 4 },
			{ role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "contents of a.ts" }], timestamp: 5 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } }], timestamp: 6 },
			{ role: "developer", content: "Use the recorded evidence", timestamp: 6 },
			{ role: "toolResult", toolCallId: "call-b", toolName: "read", content: [{ type: "text", text: "contents of b.ts" }], timestamp: 7 },
		] as Context["messages"], "required system");
		expect(() => bootstrap(ctx, { contextWindow: 2400, maxTokens: 200 })).toThrow(CursorRecoveryBudgetError);
		expect(() => bootstrap(ctx, { contextWindow: 2400, maxTokens: 200 })).toThrow(/\/compact/);
		const prepared = bootstrap(ctx, { contextWindow: 30_000, maxTokens: 200 });
		expect(prepared.history).toEqual(ctx.messages);
		const incomplete = { ...ctx, messages: ctx.messages.filter((message) => message.role !== "toolResult" || message.toolCallId !== "call-a") };
		expect(() => bootstrap(incomplete)).toThrow(/missing results/i);
	});

	test.each(["user", "developer"] as const)("recovery keeps %s images native and attaches only required result images in order", (role) => {
		const requestImage = { type: "image" as const, data: "request-payload", mimeType: "image/png" };
		const resultImage = { type: "image" as const, data: Buffer.alloc(787_271).toString("base64"), mimeType: "image/jpeg" };
		const secondImage = { type: "image" as const, data: "second-payload", mimeType: "image/png" };
		const ctx = context([
			{ role: "user", content: "OBSOLETE " + "x".repeat(20_000), timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: {} }], timestamp: 1 },
			{ role: "toolResult", toolCallId: "old", toolName: "read", content: [{ type: "image", data: "obsolete-image", mimeType: "image/png" }], timestamp: 1 },
			{ role, content: [{ type: "text", text: "Compare the screenshots" }, requestImage], timestamp: 2 },
			{ role: "assistant", content: [{ type: "toolCall", id: "capture", name: "read", arguments: { path: "screenshot.png" } }], timestamp: 3 },
			{ role: "toolResult", toolCallId: "capture", toolName: "read", content: [{ type: "text", text: "Captured screen" }, resultImage], timestamp: 4 },
			{ role: "assistant", content: [{ type: "toolCall", id: "inspect", name: "capture_screen", arguments: {} }], timestamp: 5 },
			{ role: "toolResult", toolCallId: "inspect", toolName: "capture_screen", content: [secondImage], timestamp: 6 },
		] as Context["messages"]);
		const prepared = bootstrap(ctx, { contextWindow: 50_000, maxTokens: 500 });
		expect(prepared.history).toEqual(ctx.messages);
		expect(prepared.prompt.images).toEqual([
			{ data: resultImage.data, mimeType: resultImage.mimeType },
			{ data: secondImage.data, mimeType: secondImage.mimeType },
		]);
		expect(prepared.prompt.text).not.toContain(requestImage.data);
		expect(prepared.prompt.text).not.toContain(resultImage.data);
		expect(() => bootstrap(ctx, { contextWindow: 14_000, maxTokens: 500 })).toThrow(CursorRecoveryBudgetError);
		const ordinary = bootstrap({ ...ctx, messages: [...ctx.messages, { role: "user", content: "New request", timestamp: 7 }] });
		expect(ordinary.history).toEqual(ctx.messages);
		expect(ordinary.prompt.images).toBeUndefined();
	});

	test.each([
		[{ type: "audio", data: "unsupported" }],
		[{ type: "image", mimeType: "image/png" }],
		[{ type: "image", data: "", mimeType: "image/png" }],
		[{ type: "image", data: "payload", mimeType: "text/plain" }],
		[{ type: "text", text: 42 }],
		[null],
	])("rejects malformed or unsupported completed recovery content %j", (content) => {
		const ctx = context([
			{ role: "user", content: "Inspect then summarize", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "earlier", name: "read", arguments: {} }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "earlier", toolName: "read", content: [content], timestamp: 3 },
			{ role: "assistant", content: [{ type: "toolCall", id: "final", name: "read", arguments: {} }], timestamp: 4 },
			{ role: "toolResult", toolCallId: "final", toolName: "read", content: [{ type: "text", text: "Done" }], timestamp: 5 },
		] as unknown as Context["messages"]);
		expect(() => bootstrap(ctx)).toThrow(/unsupported or malformed/i);
	});

	test.each(["user", "developer", "assistant"] as const)("rejects malformed %s recovery blocks safely", (role) => {
		const ctx = context([
			{ role: "user", content: "Inspect", timestamp: 1 },
			{ role, content: [null], timestamp: 2 },
			{ role: "assistant", content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }], timestamp: 3 },
			{ role: "toolResult", toolCallId: "read", toolName: "read", content: [{ type: "text", text: "Done" }], timestamp: 4 },
		] as unknown as Context["messages"]);
		expect(() => bootstrap(ctx)).toThrow(/unsupported or malformed/i);
	});

	test("reserves output and images and fails rather than truncating required input", () => {
		const limits = { contextWindow: 6000, maxTokens: 500 };
		const ctx = context([{ role: "user", content: "x".repeat(1000), timestamp: 1 }], "required system");
		expect(bootstrap(ctx, limits).prompt.text).toContain("x".repeat(1000));
		expect(() => bootstrap(ctx, { ...limits, maxTokens: 5000 })).toThrow(/context window exceeded/i);
		expect(() => bootstrap({ ...ctx, systemPrompt: ["s".repeat(20_000)] }, limits)).toThrow(/context window exceeded/i);
		const withImage = context([{ role: "user", content: [{ type: "text", text: "x".repeat(4000) }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 }]);
		expect(() => bootstrap(withImage, limits)).toThrow(/context window exceeded/i);
		const imported = { ...ctx, messages: [...firstUser, ...ctx.messages] };
		const required = bootstrap(imported);
		const requiredTokens = (Buffer.byteLength(required.prompt.text) + 3) >> 2;
		expect(required.prompt.text).toContain(SDK_TOOL_CONTEXT);
		expect(() => bootstrap(imported, { contextWindow: 1024 + limits.maxTokens + requiredTokens + 8, maxTokens: limits.maxTokens })).toThrow(CursorBootstrapBudgetError);
	});

	test("does not treat image encoding size as context tokens", () => {
		const limits = { contextWindow: 200_000, maxTokens: 64_000 };
		const png = (bytes: number) => Buffer.alloc(bytes).toString("base64");
		const compact = context([{
			role: "user",
			content: [{ type: "text", text: "see" }, { type: "image", data: png(1_489), mimeType: "image/png" }],
			timestamp: 1,
		}]);
		const uncompressed = context([{
			role: "user",
			content: [{ type: "text", text: "see" }, { type: "image", data: png(787_271), mimeType: "image/png" }],
			timestamp: 1,
		}]);
		const multi = context([{
			role: "user",
			content: [
				{ type: "text", text: "see" },
				{ type: "image", data: png(787_271), mimeType: "image/png" },
				{ type: "image", data: png(1_489), mimeType: "image/png" },
			],
			timestamp: 1,
		}]);
		expect(bootstrap(compact, limits).prompt.images).toHaveLength(1);
		expect(bootstrap(uncompressed, limits).prompt.images?.[0]?.data).toBe(png(787_271));
		expect(bootstrap(multi, limits).prompt.images).toHaveLength(2);
		expect(prepareSendInput({ mode: "incremental", resetAgent: false, reason: "incremental" }, uncompressed, limits).prompt.images).toHaveLength(1);
	});

	test("preserves joined system text fingerprint semantics", () => {
		const ctx = context(firstUser, ["first", "second"]);
		const equivalent = context(firstUser, "first\nsecond");
		expect(computeContextFingerprint(equivalent)).toBe(computeContextFingerprint(ctx));
	});

	test("keeps the persisted fingerprint bounded while validating the complete prefix", () => {
		const short = context([{ role: "user", content: "first", timestamp: 1 }]);
		const long = context(Array.from({ length: 1_000 }, (_, index) => ({
			role: "user" as const,
			content: `message-${index}`,
			timestamp: index,
		})));
		const shortFingerprint = computeContextFingerprint(short);
		const longFingerprint = computeContextFingerprint(long);
		expect(longFingerprint.length).toBe(shortFingerprint.length + 3);
		expect(JSON.parse(longFingerprint)).toMatchObject({
			format: "native-checkpoint-v1",
			formatVersion: 3,
			messageCount: 1_000,
		});

		const changed = structuredClone(long);
		changed.messages[500] = { role: "user", content: "changed", timestamp: 500 };
		expect(planSend({
			bootstrapped: true,
			contextFingerprint: longFingerprint,
			incrementalSendCount: 999,
		}, changed)).toMatchObject({ mode: "bootstrap", reason: "context_divergence" });
	});

	test("captures historical arguments and images before later context mutation", () => {
		const arguments_ = { path: "before.txt" };
		const image = { type: "image" as const, data: "before-image", mimeType: "image/png" };
		const ctx = context([
			{ role: "user", content: "Inspect", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: arguments_ }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [image], timestamp: 3 },
			{ role: "user", content: "Summarize", timestamp: 4 },
		] as Context["messages"]);
		const expected = structuredClone(ctx.messages.slice(0, -1));
		const prepared = bootstrap(ctx);
		arguments_.path = "after.txt";
		image.data = "after-image";
		ctx.messages.splice(0, 1);
		expect(prepared.history).toEqual(expected);
		expect(prepared.prompt.images).toBeUndefined();
	});

	test("reserves historical images without counting encoded bytes", () => {
		const image = { type: "image" as const, data: "x".repeat(1_000_000), mimeType: "image/png" };
		const ctx = context([
			{ role: "user", content: [image], timestamp: 1 },
			{ role: "user", content: "Describe it", timestamp: 2 },
		], "");
		expect(bootstrap(ctx, { contextWindow: 6000, maxTokens: 500 }).history).toEqual(ctx.messages.slice(0, -1));
		expect(() => bootstrap(ctx, { contextWindow: 5000, maxTokens: 500 })).toThrow(CursorBootstrapBudgetError);
		expect(() => bootstrap(context([{ role: "user", content: [image], timestamp: 1 }], ""), { contextWindow: 5000, maxTokens: 500 })).toThrow(/context window exceeded/i);
	});

	test("recovers ASCII-heavy tool results under 64k maxTokens without counting host metadata", () => {
		const payload = "x".repeat(140_000);
		const ctx = context([
			{ role: "user", content: "Inspect a.ts", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }], timestamp: 2, contextSnapshot: "snap".repeat(50_000) },
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: payload }], timestamp: 3 },
		] as Context["messages"]);
		const prepared = bootstrap(ctx, { contextWindow: 200_000, maxTokens: 64_000 });
		expect(prepared.history).toEqual(ctx.messages);
		expect(prepared.prompt.text).toContain("Continue the initiating request");
	});

	test("unsplittable recovery failure is not ContextOverflow", () => {
		const ctx = context([
			{ role: "user", content: "Inspect", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "x".repeat(20_000) }], timestamp: 3 },
		]);
		expect(() => bootstrap(ctx, { contextWindow: 4_000, maxTokens: 2_000 })).toThrow(CursorRecoveryBudgetError);
	});

	test("bootstraps compaction summaries as visible history", () => {
		const ctx = context([
			{ role: "compactionSummary", summary: "Earlier turns summarized", timestamp: 1 },
			{ role: "user", content: "Continue", timestamp: 2 },
		] as Context["messages"]);
		expect(bootstrap(ctx).history).toEqual(ctx.messages.slice(0, -1));
	});

	test("counts builtin cursor K3 thinking when bootstrapping the same K3", () => {
		const thinking = "t".repeat(40_000);
		const k3 = {
			role: "assistant" as const,
			content: [
				{ type: "thinking" as const, thinking },
				{ type: "toolCall" as const, id: "read-1", name: "read", arguments: {} },
			],
			api: "cursor-agent" as const,
			provider: "cursor",
			model: "kimi-k3",
			timestamp: 2,
		};
		const ctx = context([
			{ role: "user", content: "Inspect", timestamp: 1 },
			k3,
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "ok" }], timestamp: 3 },
		] as Context["messages"]);
		const limits = { contextWindow: 8_000, maxTokens: 200 };
		expect(bootstrap(ctx, limits).history).toEqual(ctx.messages);
		expect(bootstrap(ctx, limits, "composer-2.5").history).toEqual(ctx.messages);
		expect(() => bootstrap(ctx, limits, "kimi-k3")).toThrow(CursorRecoveryBudgetError);
		const sdkOwn = context([
			{ role: "user", content: "Inspect", timestamp: 1 },
			{ ...k3, api: "cursor-sdk-agent", provider: "cursor-sdk" },
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "ok" }], timestamp: 3 },
		] as Context["messages"]);
		expect(bootstrap(sdkOwn, limits, "kimi-k3").history).toEqual(sdkOwn.messages);
	});

	test("counts native tool-call ids and framing on a long recovery chain", () => {
		const ctx = context([
			{ role: "user", content: "Inspect", timestamp: 1 },
			{
				role: "assistant",
				content: Array.from({ length: 80 }, (_, i) => ({ type: "toolCall" as const, id: `c${i}`, name: "r", arguments: {} })),
				timestamp: 2,
			},
			...Array.from({ length: 80 }, (_, i) => ({
				role: "toolResult" as const,
				toolCallId: `c${i}`,
				toolName: "r",
				content: [{ type: "text" as const, text: "ok" }],
				timestamp: 3 + i,
			})),
		] as Context["messages"]);
		expect(() => bootstrap(ctx, { contextWindow: 3_500, maxTokens: 200 })).toThrow(CursorRecoveryBudgetError);
		expect(bootstrap(ctx, { contextWindow: 200_000, maxTokens: 200 }).history).toEqual(ctx.messages);
	});
});

describe("legacy Cursor session tool-call migration", () => {
	function migrate() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerLegacyCursorToolCallIdMigration({
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(event, handler);
			},
		} as never);
		return async (messages: Context["messages"], ctx?: unknown) => {
			const event = { type: "context", messages: structuredClone(messages) };
			const result = await handlers.get("context")!(event, ctx) as { messages?: Context["messages"] } | undefined;
			return result?.messages ?? event.messages;
		};
	}

	function assistant(ids: string[], provider = "cursor-sdk", api = "cursor-sdk-agent") {
		return {
			role: "assistant",
			provider,
			api,
			content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: id } })),
			timestamp: 1,
		} as Context["messages"][number];
	}

	function result(id: string) {
		return {
			role: "toolResult", toolCallId: id, toolName: "read",
			content: [{ type: "text", text: id }], isError: false, timestamp: 2,
		} as Context["messages"][number];
	}

	const ids = ["a", "b"].map((suffix) => "x".repeat(64) + suffix.repeat(22));

	test("migrates legacy long Cursor IDs and pairs reversed results", async () => {
		const messages = [assistant(ids), result(ids[1]!), result(ids[0]!)];
		const original = structuredClone(messages);
		const projected = await migrate()(messages);
		const calls = projected.flatMap((message) => message.role === "assistant"
			? message.content.filter((block) => block.type === "toolCall")
			: []);

		expect(calls).toHaveLength(2);
		expect(calls[0]!.id).not.toBe(calls[1]!.id);
		for (const call of calls) {
			expect(call.id).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(call.id.length).toBeGreaterThan(0);
			expect(call.id.length).toBeLessThanOrEqual(64);
			expect(normalizeToolCallId(call.id)).toBe(call.id);
		}
		expect(projected[1]).toMatchObject({ toolCallId: calls[1]!.id, content: [{ type: "text", text: ids[1] }] });
		expect(projected[2]).toMatchObject({ toolCallId: calls[0]!.id, content: [{ type: "text", text: ids[0] }] });
		expect(messages).toEqual(original);
	});

	test.each(["openai-codex-responses", "openai-responses", "cursor-sdk-agent", undefined])("migrates regardless of target model (%s)", async (api: string | undefined) => {
		const messages = [assistant(ids), result(ids[0]!), result(ids[1]!)];
		const projected = await migrate()(messages, api ? { model: { api } } : {});
		const first = projected[0]!;
		if (first.role !== "assistant" || first.content[0]?.type !== "toolCall") throw new Error("Missing migrated call");
		expect(first.content[0].id).not.toBe(ids[0]);
		expect(normalizeToolCallId(first.content[0].id)).toBe(first.content[0].id);
		expect(projected[1]).toMatchObject({ toolCallId: first.content[0].id });
	});

	test("leaves other providers, unpaired results, and already-portable IDs unchanged", async () => {
		const boundaryId = "b".repeat(64);
		const messages = [
			assistant([ids[0]!], "other-provider"),
			result(ids[0]!),
			assistant([ids[1]!], "cursor-sdk", "other-api"),
			result(ids[1]!),
			assistant([boundaryId]),
			result(boundaryId),
			result("unpaired".repeat(11)),
		];
		expect(await migrate()(messages)).toEqual(messages);
	});

	test("does not rewrite an unrelated provider's result when it later reuses an adapter ID", async () => {
		const id = ids[0]!;
		const messages = [
			assistant([id]), result(id),
			assistant([id], "other-provider", "openai-responses"), result(id),
		];
		const projected = await migrate()(messages);
		const first = projected[0]!;
		if (first.role !== "assistant" || first.content[0]?.type !== "toolCall") throw new Error("Missing migrated call");
		expect(first.content[0].id.length).toBeLessThanOrEqual(64);
		expect(projected[1]).toMatchObject({ toolCallId: first.content[0].id });
		expect(projected.slice(2)).toEqual(messages.slice(2));
	});

	test("does not mutate messages when OMP only shallow-copied the array", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerLegacyCursorToolCallIdMigration({
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(event, handler);
			},
		} as never);
		const messages = [assistant(ids), result(ids[1]!), result(ids[0]!)];
		const original = structuredClone(messages);
		const event = { type: "context", messages: [...messages] };
		const projected = await handlers.get("context")!(event, {}) as { messages: Context["messages"] };
		expect(messages).toEqual(original);
		expect(event.messages).toEqual(original);
		const calls = projected.messages[0]!;
		if (calls.role !== "assistant" || calls.content[0]?.type !== "toolCall" || calls.content[1]?.type !== "toolCall") {
			throw new Error("Missing migrated call");
		}
		expect(calls.content[0].id).not.toBe(ids[0]);
		expect(calls.content[0].id.length).toBeLessThanOrEqual(64);
		expect(projected.messages[1]).toMatchObject({ toolCallId: calls.content[1].id });
		expect(projected.messages[2]).toMatchObject({ toolCallId: calls.content[0].id });
	});

	test("does not collapse duplicate toolCalls; native import still rejects them", async () => {
		const raw = ids[0]!;
		const messages = [assistant([raw, raw])];
		const projected = await migrate()(messages);
		const first = projected[0]!;
		if (first.role !== "assistant") throw new Error("Missing migrated assistant");
		const calls = first.content.filter((block) => block.type === "toolCall");
		expect(calls).toHaveLength(2);
		expect(calls[0]!.id).toBe(calls[1]!.id);
		expect(normalizeToolCallId(calls[0]!.id)).toBe(calls[0]!.id);
		await expect(buildNativeHistory(projected, { id: "composer-2.5" } as ModelSelection))
			.rejects.toThrow("Cannot import native history with duplicate tool call IDs");
	});
});
