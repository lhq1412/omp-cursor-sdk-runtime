import { describe, expect, test } from "bun:test";
import { SDK_TOOL_CONTEXT } from "../../src/constants.ts";
import { activeUserInput, activeUserText, computeContextFingerprint, emptySendState, planSend, prepareSendInput, registerCursorToolCallIds, type ModelInputLimits } from "../../src/context.ts";
import type { Context } from "@oh-my-pi/pi-ai";

const modelLimits = { contextWindow: 200_000, maxTokens: 20_000 };

function context(messages: Context["messages"], systemPrompt: Context["systemPrompt"] = ["sys"]): Context {
	return { systemPrompt, messages };
}

function bootstrap(ctx: Context, limits: ModelInputLimits = modelLimits) {
	return prepareSendInput(planSend(emptySendState(), ctx), ctx, limits);
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

	test("sanitizes structured OMP prompts and falls back when markers are absent", () => {
		const structured = [
			"<system-conventions>",
			"Stay in this prefix.",
			"# Internal URLs",
			"HOST_CATALOG must vanish",
			"§ Workflow",
			"Keep this workflow.",
		].join("\n");
		const text = bootstrap(context(firstUser, structured)).prompt.text;
		expect(text).toContain("Stay in this prefix.");
		expect(text).toContain("Keep this workflow.");
		expect(text).not.toContain("HOST_CATALOG");

		const unmarked = "  Be terse. Extra.  ";
		expect(bootstrap(context(firstUser, unmarked)).prompt.text).toContain("Be terse. Extra.");

		const incomplete = "<system-conventions>\n# Internal URLs\nHOST_CATALOG stays\nno workflow marker";
		expect(bootstrap(context(firstUser, incomplete)).prompt.text).toContain(incomplete);
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

	test("identical committed input continues even when a periodic bootstrap is due", () => {
		const ctx = context(firstUser);
		for (const incrementalSendCount of [0, 19, 20]) {
			const plan = planSend({ bootstrapped: true, contextFingerprint: computeContextFingerprint(ctx), incrementalSendCount }, ctx);
			const prepared = prepareSendInput(plan, ctx, modelLimits);
			expect(prepared.prompt.text).toEndWith(activeUserInput(ctx, true).text);
			expect(plan.continueOnly).toBe(true);
			expect(plan.mode).toBe(incrementalSendCount < 20 ? "incremental" : "bootstrap");
			expect(prepared.history).toEqual(incrementalSendCount < 20 ? undefined : ctx.messages);
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
		const prepared = bootstrap(ctx, { contextWindow: 2200, maxTokens: 200 });
		expect(prepared.history).toEqual(ctx.messages.slice(4, -1));
		expect(prepared.prompt.text).toContain("required system");
		expect(prepared.prompt.text).toEndWith("CURRENT");
	});

	test("recovery trims older turns but keeps the initiating request and all completed batches", () => {
		const ctx = context([
			{ role: "user", content: "OBSOLETE " + "x".repeat(5000), timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "Old answer" }], timestamp: 2 },
			{ role: "user", content: "Compare a.ts and b.ts", timestamp: 3 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } }], timestamp: 4 },
			{ role: "toolResult", toolCallId: "call-a", toolName: "read", content: [{ type: "text", text: "contents of a.ts" }], timestamp: 5 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } }], timestamp: 6 },
			{ role: "developer", content: "Use the recorded evidence", timestamp: 6 },
			{ role: "toolResult", toolCallId: "call-b", toolName: "read", content: [{ type: "text", text: "contents of b.ts" }], timestamp: 7 },
		] as Context["messages"], "required system");
		const prepared = bootstrap(ctx, { contextWindow: 2400 + Buffer.byteLength(`${SDK_TOOL_CONTEXT}\n\n`), maxTokens: 200 });
		expect(prepared.history).toEqual(ctx.messages.slice(2));
		expect(prepared.prompt.text).toContain("required system");
		expect(prepared.prompt.text).not.toContain("Compare a.ts and b.ts");
		expect(prepared.prompt.images).toBeUndefined();
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
		const prepared = bootstrap(ctx, { contextWindow: 17_000, maxTokens: 500 });
		expect(prepared.history).toEqual(ctx.messages.slice(3));
		expect(prepared.prompt.images).toEqual([
			{ data: resultImage.data, mimeType: resultImage.mimeType },
			{ data: secondImage.data, mimeType: secondImage.mimeType },
		]);
		expect(prepared.prompt.text).not.toContain(requestImage.data);
		expect(prepared.prompt.text).not.toContain(resultImage.data);
		expect(() => bootstrap(ctx, { contextWindow: 14_000, maxTokens: 500 })).toThrow(/context window exceeded/i);
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
		expect(() => bootstrap({ ...ctx, systemPrompt: ["s".repeat(6000)] }, limits)).toThrow(/context window exceeded/i);
		const withImage = context([{ role: "user", content: [{ type: "text", text: "x".repeat(1000) }, { type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 }]);
		expect(() => bootstrap(withImage, limits)).toThrow(/context window exceeded/i);
		const imported = { ...ctx, messages: [...firstUser, ...ctx.messages] };
		const required = bootstrap(ctx);
		const requiredTextBytes = Buffer.byteLength(required.prompt.text);
		expect(bootstrap(imported, { contextWindow: 1024 + limits.maxTokens + requiredTextBytes, maxTokens: limits.maxTokens })).toEqual(required);
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

	test("invalidates flattened fingerprints and hashes raw instructions before sanitation", () => {
		const ctx = context(firstUser, "<system-conventions>\n# Internal URLs\nold catalog\n§ Workflow\nKeep going.");
		const fingerprint = JSON.parse(computeContextFingerprint(ctx));
		delete fingerprint.format;
		expect(planSend({ bootstrapped: true, contextFingerprint: JSON.stringify(fingerprint), incrementalSendCount: 0 }, ctx)).toEqual({
			mode: "bootstrap", resetAgent: true, reason: "context_divergence",
		});
		const changed = context(firstUser, "<system-conventions>\n# Internal URLs\nnew catalog\n§ Workflow\nKeep going.");
		expect(bootstrap(changed).prompt).toEqual(bootstrap(ctx).prompt);
		expect(planSend({ bootstrapped: true, contextFingerprint: computeContextFingerprint(ctx), incrementalSendCount: 0 }, changed)).toEqual({
			mode: "bootstrap", resetAgent: true, reason: "context_divergence", continueOnly: true,
		});
	});

	test("preserves joined system text fingerprint semantics", () => {
		const ctx = context(firstUser, ["first", "second"]);
		const equivalent = context(firstUser, "first\nsecond");
		expect(computeContextFingerprint(equivalent)).toBe(computeContextFingerprint(ctx));
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
		expect(bootstrap(ctx, { contextWindow: 5000, maxTokens: 500 }).history).toEqual([]);
		expect(() => bootstrap(context([{ role: "user", content: [image], timestamp: 1 }], ""), { contextWindow: 5000, maxTokens: 500 })).toThrow(/context window exceeded/i);
	});
});

describe("Cursor tool call context projection", () => {
	function registerProjection() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerCursorToolCallIds({
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(event, handler);
			},
		} as never);
		return async (messages: Context["messages"], api?: string) => {
			const event = { type: "context", messages: structuredClone(messages) };
			const result = await handlers.get("context")!(event, { model: api ? { api } : undefined }) as { messages?: Context["messages"] } | undefined;
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

	test("projects historical same-name calls to distinct Codex-safe IDs and pairs reversed results", async () => {
		const project = registerProjection();
		const messages = [assistant(ids), result(ids[1]!), result(ids[0]!)];
		const original = structuredClone(messages);
		const projected = await project(messages, "openai-codex-responses");
		const calls = projected.flatMap((message) => message.role === "assistant"
			? message.content.filter((block) => block.type === "toolCall")
			: []);

		expect(calls).toHaveLength(2);
		expect(calls[0]!.id).not.toBe(calls[1]!.id);
		for (const call of calls) {
			expect(call.id.length).toBeGreaterThan(0);
			expect(call.id.length).toBeLessThanOrEqual(64);
		}
		expect(projected[1]).toMatchObject({ toolCallId: calls[1]!.id, content: [{ type: "text", text: ids[1] }] });
		expect(projected[2]).toMatchObject({ toolCallId: calls[0]!.id, content: [{ type: "text", text: ids[0] }] });
		expect(messages).toEqual(original);
		expect(await project(messages, "cursor-sdk-agent")).toEqual(original);
	});

	test.each(["openai-responses", undefined])("retains callback IDs outside Codex (%s)", async (api) => {
		const messages = [assistant(ids), result(ids[0]!), result(ids[1]!)];
		expect(await registerProjection()(messages, api)).toEqual(messages);
	});

	test("leaves non-adapter origins, unpaired results, and 64-character IDs unchanged", async () => {
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
		expect(await registerProjection()(messages, "openai-codex-responses")).toEqual(messages);
	});

	test("does not rewrite an unrelated provider's result when it later reuses an adapter ID", async () => {
		const id = ids[0]!;
		const messages = [
			assistant([id]), result(id),
			assistant([id], "other-provider", "openai-responses"), result(id),
		];
		const projected = await registerProjection()(messages, "openai-codex-responses");
		const first = projected[0]!;
		if (first.role !== "assistant" || first.content[0]?.type !== "toolCall") throw new Error("Missing projected call");
		expect(first.content[0].id.length).toBeLessThanOrEqual(64);
		expect(projected[1]).toMatchObject({ toolCallId: first.content[0].id });
		expect(projected.slice(2)).toEqual(messages.slice(2));
	});

	test("does not mutate messages when OMP only shallow-copied the array", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerCursorToolCallIds({
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(event, handler);
			},
		} as never);
		const messages = [assistant(ids), result(ids[1]!), result(ids[0]!)];
		const original = structuredClone(messages);
		// Mirror OMP's structuredClone failure path: array copy only, shared message objects.
		const event = { type: "context", messages: [...messages] };
		const projected = await handlers.get("context")!(event, { model: { api: "openai-codex-responses" } }) as { messages: Context["messages"] };
		expect(messages).toEqual(original);
		expect(event.messages).toEqual(original);
		const calls = projected.messages[0]!;
		if (calls.role !== "assistant" || calls.content[0]?.type !== "toolCall" || calls.content[1]?.type !== "toolCall") {
			throw new Error("Missing projected call");
		}
		expect(calls.content[0].id).not.toBe(ids[0]);
		expect(calls.content[0].id.length).toBeLessThanOrEqual(64);
		expect(projected.messages[1]).toMatchObject({ toolCallId: calls.content[1].id });
		expect(projected.messages[2]).toMatchObject({ toolCallId: calls.content[0].id });
	});
});
