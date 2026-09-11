import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Context, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";
import { Effort, type Api } from "@oh-my-pi/pi-ai";
import type { ModelListItem, ModelSelection, Run, RunResult, SDKAgent, SendOptions, TokenUsage } from "@cursor/sdk";
import { CURSOR_API_KEY_ENV_VAR, CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { streamCursorRuntime } from "../../src/provider.ts";
import { buildModelSelection, ensureCursorModels, getModelMetadata, __testUtils as catalogTestUtils } from "../../src/catalog.ts";
import { __testUtils as controlsTestUtils } from "../../src/model-controls.ts";
import { disposeRuntimeForScope, __testUtils as runtimeTestUtils } from "../../src/session-runtime.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
import { __testUtils as resumeTestUtils } from "../../src/session-resume.ts";

const COMPOSER: ModelListItem = {
	id: "composer-2.5",
	displayName: "Composer 2.5",
	aliases: ["composer-2"],
	parameters: [
		{ id: "fast", values: [{ value: "true" }, { value: "false" }] },
		{ id: "context", values: [{ value: "200k" }, { value: "1m" }] },
		{ id: "effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
		{ id: "reasoning", values: [{ value: "none" }, { value: "off" }, { value: "low" }, { value: "medium" }, { value: "high" }] },
	],
	variants: [
		{
			isDefault: true,
			displayName: "Composer 2.5",
			params: [
				{ id: "fast", value: "false" },
				{ id: "context", value: "1m" },
			],
		},
	],
};

const GPT: ModelListItem = {
	id: "gpt-5",
	displayName: "GPT-5",
	parameters: [
		{ id: "context", values: [{ value: "200k" }, { value: "1m" }, { value: "max" }] },
		{ id: "fast", values: [{ value: "true" }, { value: "false" }] },
	],
	variants: [
		{
			isDefault: true,
			displayName: "GPT-5",
			params: [
				{ id: "fast", value: "false" },
				{ id: "context", value: "1m" },
			],
		},
	],
};

function cursorModel(id: string, contextWindow: number): Model<Api> {
	return {
		id,
		provider: CURSOR_SDK_PROVIDER_ID,
		api: CURSOR_SDK_API,
		contextWindow,
		maxTokens: 8_192,
	} as Model<Api>;
}

function userContext(text: string, tools: Tool[] = []): Context {
	return {
		messages: [{ role: "user", content: text, timestamp: 1 } as Context["messages"][number]],
		tools,
	};
}

function readTool(): Tool {
	return {
		name: "read",
		description: "read",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	} as Tool;
}

function recordedToolContext(resultIds = ["call-1", "call-2"]): Context {
	return {
		messages: [
			{ role: "user", content: "Inspect a.ts and b.ts, then summarize.", timestamp: 1 },
			{ role: "assistant", content: [
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "b.ts" } },
			], timestamp: 2 },
			...resultIds.map((toolCallId) => ({
				role: "toolResult", toolCallId, toolName: "read",
				content: [{ type: "text", text: `Recorded contents for ${toolCallId}` }],
				isError: false, timestamp: 3,
			})),
		],
		tools: [readTool()],
	} as Context;
}

function finishedRun(): Run {
	return {
		supports: () => false,
		wait: async (): Promise<RunResult> => ({ status: "finished" }) as RunResult,
	} as unknown as Run;
}

function param(selection: ModelSelection | undefined, id: string): string | undefined {
	return selection?.params?.find((item) => item.id === id)?.value;
}

async function drain(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const events = [];
	for await (const event of streamCursorRuntime(model, context, { ...options, onPayload: options?.onPayload ?? scopeTestUtils.bindRequest })) {
		events.push(event);
	}
	return events;
}

function installCapturingAgent(
	created: ModelSelection[],
	sent: ModelSelection[],
	send?: (options: SendOptions | undefined) => Promise<Run>,
): void {
	runtimeTestUtils.setOpenAgent(async (input) => {
		created.push(input.model);
		return {
			agentId: input.savedAgentId ?? "agent-1",
			close() {},
			async [Symbol.asyncDispose]() {},
			async send(_message, options) {
				if (options?.model) sent.push(options.model);
				if (send) return send(options);
				return finishedRun();
			},
		} as unknown as SDKAgent;
	});
}

function seedCatalog(items: ModelListItem[] = [COMPOSER, GPT], listKeys?: string[]): void {
	catalogTestUtils.resetCatalog();
	catalogTestUtils.setListModels(async (apiKey: string) => {
		listKeys?.push(apiKey);
		return items;
	});
	catalogTestUtils.registerModelItems(items);
}

describe("streamCursorRuntime model selection", () => {
	beforeEach(async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		controlsTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		seedCatalog();
		await ensureCursorModels("test-key");
	});

	afterEach(() => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		controlsTestUtils.reset();
		catalogTestUtils.resetCatalog();
	});

	test("passes one built ModelSelection to Agent.create and send", async () => {
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		installCapturingAgent(created, sent);
		const model = cursorModel("composer-2.5", 1_000_000);
		const expected = buildModelSelection("composer-2.5", Effort.High, {
			apiKey: "test-key",
			fastEnabled: false,
			extendedContextEnabled: true,
		});
		await drain(model, userContext("hi"), { apiKey: "test-key", cwd: "/tmp/project", reasoning: Effort.High });
		expect(created).toEqual([expected]);
		expect(sent).toEqual([expected]);
		expect(created[0]?.id).toBe("composer-2.5");
		expect(param(sent[0], "effort") ?? param(sent[0], "reasoning")).toBe("high");
		expect(param(sent[0], "context")).toBe("1m");
		expect(param(sent[0], "fast")).toBe("false");
	});

	test("disableReasoning wins over reasoning and still uses catalog context threshold", async () => {
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		installCapturingAgent(created, sent);
		const model = cursorModel("composer-2.5", 200_000);
		const expected = buildModelSelection("composer-2.5", "off", {
			apiKey: "test-key",
			fastEnabled: false,
			extendedContextEnabled: false,
		});
		await drain(model, userContext("hi"), {
			apiKey: "test-key",
			cwd: "/tmp/project",
			reasoning: Effort.High,
			disableReasoning: true,
		});
		expect(created).toEqual([expected]);
		expect(sent).toEqual([expected]);
		expect(param(sent[0], "effort")).not.toBe("high");
		expect(param(sent[0], "reasoning")).not.toBe("high");
		expect(param(sent[0], "context")).toBe("200k");
	});

	test("fast preference is applied on the canonical base model id", async () => {
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		installCapturingAgent(created, sent);
		controlsTestUtils.sessionFastPreferences.set("composer-2.5", true);
		const expected = buildModelSelection("composer-2.5", "off", {
			apiKey: "test-key",
			fastEnabled: true,
			extendedContextEnabled: true,
		});
		await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi"), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		expect(sent).toEqual([expected]);
		expect(param(sent[0], "fast")).toBe("true");
	});

	test("canonicalizes a non-default @context row onto the SDK base id", async () => {
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		installCapturingAgent(created, sent);
		const rowId = getModelMetadata("gpt-5@200k", "test-key") ? "gpt-5@200k" : "gpt-5";
		const metadata = getModelMetadata(rowId, "test-key");
		expect(metadata?.baseModelId).toBe("gpt-5");
		await drain(cursorModel(rowId, metadata?.contextWindow ?? 200_000), userContext("hi"), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		expect(created[0]?.id).toBe("gpt-5");
		expect(sent[0]?.id).toBe("gpt-5");
		if (rowId.includes("@")) {
			expect(param(created[0], "context")).toBe("200k");
		}
	});

	test("hydrates the catalog with the resolved credential", async () => {
		const listKeys: string[] = [];
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setListModels(async (apiKey: string) => {
			listKeys.push(apiKey);
			return [COMPOSER];
		});
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		installCapturingAgent(created, sent);
		const previous = process.env[CURSOR_API_KEY_ENV_VAR];
		process.env[CURSOR_API_KEY_ENV_VAR] = "resolved-secret";
		try {
			await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi"), {
				apiKey: CURSOR_API_KEY_ENV_VAR,
				cwd: "/tmp/project",
			});
		} finally {
			if (previous === undefined) delete process.env[CURSOR_API_KEY_ENV_VAR];
			else process.env[CURSOR_API_KEY_ENV_VAR] = previous;
		}
		expect(listKeys).toEqual(["resolved-secret"]);
		expect(created).toHaveLength(1);
		expect(sent).toHaveLength(1);
	});

	test("parked continuation resumes the original run instead of sending a new selection", async () => {
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		let usage: TokenUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, totalTokens: 135 };
		installCapturingAgent(created, sent, async (options) => {
			const tool = options?.local?.customTools?.read;
			if (!tool) return finishedRun();
			await options?.onDelta?.({ update: { type: "step-started", stepId: 1 } });
			await options?.onDelta?.({ update: { type: "text-delta", text: "Inspecting." } });
			const pending = tool.execute({ path: "a.ts" }, { toolCallId: "call-1" });
			return {
				id: "run-current",
				get usage() { return usage; },
				supports: () => false,
				wait: async () => {
					await pending;
					await options?.onDelta?.({ update: { type: "step-started", stepId: 2 } });
					await options?.onDelta?.({ update: { type: "text-delta", text: "All " } });
					usage = { inputTokens: 140, outputTokens: 16, cacheReadTokens: 30, cacheWriteTokens: 5, totalTokens: 191 };
					return { id: "run-current", status: "finished", result: "All done.", usage } as RunResult;
				},
			} as unknown as Run;
		});
		const first = await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		expect(first.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
		expect(first.at(-1)).toMatchObject({ message: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 135, orchestration: { input: 105, output: 10, cacheRead: 20 } } } });
		expect(created).toHaveLength(1);
		expect(sent).toHaveLength(1);
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setListModels(async () => {
			throw new Error("should not rehydrate parked continuation");
		});
		controlsTestUtils.sessionFastPreferences.set("composer-2.5", true);
		const second = await drain(
			cursorModel("composer-2.5", 200_000),
			{
				messages: [
					{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number],
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 2,
					},
				],
				tools: [readTool()],
			} as Context,
			{ apiKey: "test-key", cwd: "/tmp/project", reasoning: Effort.High, disableReasoning: true },
		);
		expect(created).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(second.at(-1)).toMatchObject({
			type: "done",
			message: {
				content: [{ type: "text", text: "All done." }],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 56, orchestration: { input: 40, output: 6, cacheRead: 10 } },
				cursorSdk: { tokenUsage: "actual", cost: "unavailable" },
			},
		});
	});

	test("abort after parked continuation records only newly reported usage", async () => {
		let usage: TokenUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, totalTokens: 135 };
		const { promise: afterResume, resolve: resumed } = Promise.withResolvers<void>();
		installCapturingAgent([], [], async (options) => {
			const tool = options?.local?.customTools?.read;
			if (!tool) return finishedRun();
			const pending = tool.execute({ path: "a.ts" }, { toolCallId: "call-1" });
			return {
				id: "run-current",
				get usage() {
					return usage;
				},
				supports: (feature: string) => feature === "cancel",
				cancel: async () => undefined,
				wait: async () => {
					await pending;
					usage = { inputTokens: 160, outputTokens: 18, cacheReadTokens: 20, cacheWriteTokens: 5, totalTokens: 203 };
					resumed();
					await new Promise(() => undefined);
					return { id: "run-current", status: "cancelled", usage } as RunResult;
				},
			} as unknown as Run;
		});
		const first = await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		expect(first.at(-1)).toMatchObject({ type: "done", reason: "toolUse", message: { usage: { totalTokens: 135 } } });
		const controller = new AbortController();
		const second = drain(
			cursorModel("composer-2.5", 200_000),
			{
				messages: [
					{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number],
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 2,
					},
				],
				tools: [readTool()],
			} as Context,
			{ apiKey: "test-key", cwd: "/tmp/project", signal: controller.signal },
		);
		await afterResume;
		controller.abort();
		const events = await second;
		expect(events.at(-1)).toMatchObject({
			type: "error",
			reason: "aborted",
			error: { stopReason: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 68, orchestration: { input: 60, output: 8, cacheRead: 0 } } },
		});
	});

	test("reconstructs a lost parked run on a fresh agent without replaying completed tools", async () => {
		const opened: Array<string | undefined> = [];
		const histories: Array<Context["messages"] | undefined> = [];
		const sent: Array<{ agentId: string; message: unknown; model: ModelSelection | undefined }> = [];
		let toolExecutions = 0;
		let oldCallbackResolved = false;
		runtimeTestUtils.setOpenAgent(async (input) => {
			opened.push(input.savedAgentId);
			histories.push(input.bootstrapHistory);
			const agentId = `agent-${opened.length}`;
			return {
				agentId,
				close() {},
				async [Symbol.asyncDispose]() {},
				async send(message, options) {
					sent.push({ agentId, message, model: options?.model });
					if (agentId !== "agent-1") {
						return { supports: () => false, wait: async () => ({ status: "finished", result: "Summary from recorded contents." }) } as unknown as Run;
					}
					const tool = options?.local?.customTools?.read;
					if (!tool) throw new Error("read tool not exposed");
					toolExecutions += 1;
					const pending = tool.execute({ path: "a.ts" }, { toolCallId: "call-1" });
					return {
						supports: () => false,
						wait: async () => {
							await pending;
							oldCallbackResolved = true;
							return { status: "finished" } as RunResult;
						},
					} as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
		const initial = userContext("Inspect a.ts, then summarize.", [readTool()]);
		const first = await drain(cursorModel("composer-2.5", 200_000), initial, { apiKey: "test-key", cwd: "/tmp/project" });
		const done = first.at(-1);
		expect(done).toMatchObject({ type: "done", reason: "toolUse" });
		if (done?.type !== "done") throw new Error("Expected parked assistant message");
		const recoveredContext = {
			...initial,
			messages: [
				...initial.messages,
				{ role: "assistant", content: [{ type: "toolCall", id: "capture", name: "read", arguments: { path: "screenshot.png" } }], timestamp: 1 },
				{ role: "toolResult", toolCallId: "capture", toolName: "read", content: [{ type: "text", text: "Previously captured screen" }, { type: "image", data: "screen-payload", mimeType: "image/png" }], isError: false, timestamp: 2 },
				done.message,
				{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Completed read: export const answer = 42;" }], isError: false, timestamp: 3 },
			],
		} as Context;
		await disposeRuntimeForScope();
		const listed: string[] = [];
		seedCatalog([COMPOSER, GPT], listed);
		controlsTestUtils.sessionFastPreferences.set("composer-2.5", true);
		const recovered = await drain(cursorModel("composer-2.5", 200_000), recoveredContext, { apiKey: "test-key", cwd: "/tmp/project" });
		expect(listed).toEqual(["test-key"]);
		expect(opened).toEqual([undefined, undefined]);
		expect(sent.map(({ agentId }) => agentId)).toEqual(["agent-1", "agent-2"]);
		expect(param(sent[1]?.model, "fast")).toBe("true");
		expect(histories[1]).toEqual(recoveredContext.messages);
		expect(sent[1]?.message).toMatchObject({ images: [{ data: "screen-payload", mimeType: "image/png" }] });
		expect(sent[1]?.message).toMatchObject({ text: expect.not.stringContaining("Inspect a.ts, then summarize.") });
		expect(toolExecutions).toBe(1);
		expect(oldCallbackResolved).toBe(false);
		expect(recovered.some((event) => event.type === "toolcall_start")).toBe(false);
		expect(recovered.at(-1)).toMatchObject({
			type: "done", reason: "stop", message: { content: [{ type: "text", text: "Summary from recorded contents." }] },
		});
	});

	test.each([
		["missing", ["call-1"]],
		["duplicate", ["call-1", "call-2", "call-1"]],
		["unmatched", ["call-1", "call-2", "unknown"]],
	] as const)("rejects %s recovery results before opening or sending an agent", async (_name, ids) => {
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		installCapturingAgent(created, sent);
		const events = await drain(cursorModel("composer-2.5", 200_000), recordedToolContext([...ids]), { apiKey: "test-key", cwd: "/tmp/project" });
		expect(events.at(-1)).toMatchObject({ type: "error" });
		expect(created).toEqual([]);
		expect(sent).toEqual([]);
	});

	test.each(["request", "result", "images"])("fails recovery rather than dropping its required oversized %s", async (oversized) => {
		const context = recordedToolContext();
		if (oversized === "request") {
			context.messages[0] = { role: "user", content: "Required initiating request " + "x".repeat(20_000), timestamp: 1 };
		} else if (oversized === "images") {
			context.messages[3] = { role: "toolResult", toolCallId: "call-2", toolName: "read", content: Array.from({ length: 3 }, () => ({ type: "image" as const, data: "screen-payload", mimeType: "image/png" })), isError: false, timestamp: 4 };
		} else {
			context.messages[3] = { role: "toolResult", toolCallId: "call-2", toolName: "read", content: [{ type: "text", text: "Required completed result " + "x".repeat(20_000) }], isError: false, timestamp: 4 };
		}
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		installCapturingAgent(created, sent);
		const events = await drain(cursorModel("composer-2.5", 10_000), context, { apiKey: "test-key", cwd: "/tmp/project" });
		expect(events.at(-1)).toMatchObject({ type: "error", error: { errorMessage: expect.stringMatching(/context window exceeded/i) } });
		expect(created).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("parked continuation does not hydrate a different credential", async () => {
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		installCapturingAgent(created, sent, async (options) => {
			const tool = options?.local?.customTools?.read;
			if (!tool) return finishedRun();
			const pending = tool.execute({ path: "a.ts" }, { toolCallId: "call-1" });
			return {
				supports: () => false,
				wait: async () => {
					await pending;
					return { status: "finished" } as RunResult;
				},
			} as unknown as Run;
		});
		await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		const listed: string[] = [];
		catalogTestUtils.setListModels(async (apiKey: string) => {
			listed.push(apiKey);
			throw new Error(`unexpected list for ${apiKey}`);
		});
		const events = await drain(
			cursorModel("composer-2.5", 1_000_000),
			{
				messages: [
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 2,
					},
				],
				tools: [readTool()],
			} as Context,
			{ apiKey: "key-b", cwd: "/tmp/project" },
		);
		expect(listed).toEqual([]);
		expect(created).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({
			type: "error",
			error: { errorMessage: expect.stringMatching(/cwd or credentials changed/) },
		});
	});
});
