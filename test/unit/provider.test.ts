import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Context, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";
import { Effort, type Api } from "@oh-my-pi/pi-ai";
import type { ModelListItem, ModelSelection, Run, RunResult, SDKAgent, SendOptions } from "@cursor/sdk";
import { CURSOR_API_KEY_ENV_VAR, CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { streamCursorRuntime } from "../../src/provider.ts";
import { buildModelSelection, ensureCursorModels, getModelMetadata, __testUtils as catalogTestUtils } from "../../src/catalog.ts";
import { __testUtils as controlsTestUtils } from "../../src/model-controls.ts";
import { __testUtils as runtimeTestUtils } from "../../src/session-runtime.ts";
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
	for await (const event of streamCursorRuntime(model, context, options)) {
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
		const first = await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		expect(first.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
		expect(created).toHaveLength(1);
		expect(sent).toHaveLength(1);
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
		expect(second.at(-1)).toMatchObject({ type: "done" });
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
