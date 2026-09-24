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
import { HOST_BRIDGE_OPTION_KEY } from "../../src/host-option.ts";
import { createFakeHost } from "../helpers/fake-host.ts";
import { projectSdkToolCallId } from "../../src/tool-call-id.ts";
import { mapOmpToolName } from "../../src/tools.ts";


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

	test("checkpoint occupancy stays unavailable while parked and settles separately from billing", async () => {
		let root = "previous-turn";
		let status: "idle" | "running" = "idle";
		const usage: TokenUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, totalTokens: 135 };
		runtimeTestUtils.setOpenAgent(async (input) => {
			input.store.agents.get = async () => ({
				agentId: "agent-occupancy", cwd: input.cwd, status, createdAt: 1, updatedAt: 2,
				activeRunId: status === "running" ? "run-occupancy" : null,
				latestCheckpoint: { schemaVersion: 1, rootBlobId: root },
			});
			// Field 5 contains usedTokens=150, maxTokens=100; overflow is not hidden.
			input.store.checkpoints.get = async () => new Uint8Array([42, 5, 8, 150, 1, 16, 100]);
			return {
				agentId: "agent-occupancy", close() {}, async [Symbol.asyncDispose]() {},
				async send(_message, options) {
					status = "running";
					root = "parked";
					const tool = options?.local?.customTools?.read;
					if (!tool) throw new Error("read tool missing");
					const pending = tool.execute({ path: "a.ts" }, { toolCallId: "call-occupancy" });
					return {
						id: "run-occupancy", agentId: "agent-occupancy", supports: () => false,
						wait: async () => {
							await pending;
							root = "settled";
							status = "idle";
							return { id: "run-occupancy", status: "finished", usage } as RunResult;
						},
					} as unknown as Run;
				},
			} as SDKAgent;
		});
		const context = userContext("inspect", [readTool()]);
		const parked = (await drain(cursorModel("composer-2.5", 200_000), context, { apiKey: "test-key" })).at(-1);
		expect(parked).toMatchObject({ type: "done", reason: "toolUse", message: { cursorSdk: { contextOccupancy: { status: "unavailable" } } } });
		if (parked?.type !== "done") throw new Error("Expected parked turn");
		expect(parked.message.usage.contextTokens).toBeUndefined();
		const settled = (await drain(cursorModel("composer-2.5", 200_000), {
			...context, messages: [...context.messages, parked.message,
				{ role: "toolResult", toolCallId: "call-occupancy", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 }],
		}, { apiKey: "test-key" })).at(-1);
		expect(settled).toMatchObject({ type: "done", message: {
			usage: { input: 0, output: 0, totalTokens: 135,
				orchestration: { input: 105, output: 10, cacheRead: 20 }, cost: { total: 0 } },
			cursorSdk: { cost: "unavailable", contextOccupancy: { status: "actual", source: "checkpoint", rootBlobId: "settled", maxTokens: 100 } },
		} });
		if (settled?.type !== "done") throw new Error("Expected settled turn");
		expect(settled.message.usage.contextTokens).toBeUndefined();
	});


	test.each(["abort", "navigation"] as const)("%s during optional checkpoint read cannot publish stale occupancy", async (change) => {
		const reading = Promise.withResolvers<void>();
		const blob = Promise.withResolvers<Uint8Array>();
		const controller = new AbortController();
		let root = "baseline";
		runtimeTestUtils.setOpenAgent(async (input) => {
			input.store.agents.get = async () => ({
				agentId: "agent-occupancy", cwd: input.cwd, status: "idle", createdAt: 1, updatedAt: 2,
				latestCheckpoint: { schemaVersion: 1, rootBlobId: root },
			});
			input.store.checkpoints.get = async () => { reading.resolve(); return blob.promise; };
			return {
				agentId: "agent-occupancy", close() {}, async [Symbol.asyncDispose]() {},
				async send() {
					root = "fresh";
					return { id: "run-occupancy", agentId: "agent-occupancy", supports: () => false,
						wait: async () => ({ id: "run-occupancy", status: "finished", result: "answer" }) } as Run;
				},
			} as SDKAgent;
		});
		const pending = drain(cursorModel("composer-2.5", 200_000), userContext("hi"), { apiKey: "test-key", signal: controller.signal });
		await reading.promise;
		if (change === "abort") controller.abort();
		else await disposeRuntimeForScope();
		blob.resolve(new Uint8Array([42, 5, 8, 150, 1, 16, 100]));
		const last = (await pending).at(-1);
		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("Expected cancelled or superseded request");
		expect(last.error.usage.contextTokens).toBeUndefined();
	});

	test("optional checkpoint read failure preserves the successful answer and run billing", async () => {
		let root = "baseline";
		runtimeTestUtils.setOpenAgent(async (input) => {
			input.store.agents.get = async () => ({
				agentId: "agent-occupancy", cwd: input.cwd, status: "idle", createdAt: 1, updatedAt: 2,
				latestCheckpoint: { schemaVersion: 1, rootBlobId: root },
			});
			input.store.checkpoints.get = async () => { throw new Error("disk read failed"); };
			return {
				agentId: "agent-occupancy", close() {}, async [Symbol.asyncDispose]() {},
				async send() {
					root = "fresh";
					return { id: "run-occupancy", agentId: "agent-occupancy", supports: () => false,
						wait: async () => ({ id: "run-occupancy", status: "finished", result: "answer",
							usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 23 } }),
					} as Run;
				},
			} as SDKAgent;
		});
		const last = (await drain(cursorModel("composer-2.5", 200_000), userContext("hi"), { apiKey: "test-key" })).at(-1);
		expect(last).toMatchObject({ type: "done", message: {
			content: [{ type: "text", text: "answer" }], usage: { totalTokens: 23, orchestration: { input: 20, output: 3 } },
			cursorSdk: { contextOccupancy: { status: "unavailable" } },
		} });
		if (last?.type !== "done") throw new Error("Expected successful answer");
		expect(last.message.usage.contextTokens).toBeUndefined();
	});

	test("a failed baseline read cannot publish the previous checkpoint as current occupancy", async () => {
		let gets = 0;
		runtimeTestUtils.setOpenAgent(async (input) => {
			input.store.agents.get = async () => {
				gets += 1;
				if (gets === 1) throw new Error("baseline unavailable");
				return {
					agentId: "agent-occupancy", cwd: input.cwd, status: "idle" as const, createdAt: 1, updatedAt: 2,
					latestCheckpoint: { schemaVersion: 1 as const, rootBlobId: "previous" },
				};
			};
			input.store.checkpoints.get = async () => new Uint8Array([42, 5, 8, 150, 1, 16, 100]);
			return {
				agentId: "agent-occupancy", close() {}, async [Symbol.asyncDispose]() {},
				async send() {
					return { id: "run-occupancy", agentId: "agent-occupancy", supports: () => false,
						wait: async () => ({ id: "run-occupancy", status: "finished", result: "answer" }) } as Run;
				},
			} as SDKAgent;
		});
		const last = (await drain(cursorModel("composer-2.5", 200_000), userContext("hi"), { apiKey: "test-key" })).at(-1);
		expect(last).toMatchObject({ type: "done", message: { cursorSdk: { contextOccupancy: { status: "unavailable" } } } });
		if (last?.type !== "done") throw new Error("Expected successful answer");
		expect(last.message.usage.contextTokens).toBeUndefined();
	});

	test("abort during commitBinding does not leave authoritative occupancy on the aborted message", async () => {
		const host = createFakeHost({ tools: [] });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		host.commitBinding = async () => { started.resolve(); await release.promise; };
		let root = "baseline";
		runtimeTestUtils.setOpenAgent(async (input) => {
			input.store.agents.get = async () => ({
				agentId: "agent-occupancy", cwd: input.cwd, status: "idle" as const, createdAt: 1, updatedAt: 2,
				latestCheckpoint: { schemaVersion: 1 as const, rootBlobId: root },
			});
			input.store.checkpoints.get = async () => new Uint8Array([42, 5, 8, 150, 1, 16, 100]);
			return {
				agentId: "agent-occupancy", close() {}, async [Symbol.asyncDispose]() {},
				async send() {
					root = "fresh";
					return { id: "run-occupancy", agentId: "agent-occupancy", supports: () => false,
						wait: async () => ({ id: "run-occupancy", status: "finished", result: "answer" }) } as Run;
				},
			} as SDKAgent;
		});
		const controller = new AbortController();
		const pending = drain(cursorModel("composer-2.5", 200_000), userContext("hi"), {
			apiKey: "test-key",
			signal: controller.signal,
			[HOST_BRIDGE_OPTION_KEY]: host,
		} as SimpleStreamOptions);
		await started.promise;
		controller.abort();
		release.resolve();
		const last = (await pending).at(-1);
		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("Expected aborted turn");
		expect(last.error.usage.contextTokens).toBeUndefined();
		expect(last.error.cursorSdk.contextOccupancy).toEqual({ status: "unavailable" });
	});

	test("abort during flushToolResults does not publish occupancy", async () => {
		const host = createFakeHost({ tools: [] });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		host.flushToolResults = async () => { started.resolve(); await release.promise; };
		let root = "baseline";
		runtimeTestUtils.setOpenAgent(async (input) => {
			input.store.agents.get = async () => ({
				agentId: "agent-occupancy", cwd: input.cwd, status: "idle" as const, createdAt: 1, updatedAt: 2,
				latestCheckpoint: { schemaVersion: 1 as const, rootBlobId: root },
			});
			input.store.checkpoints.get = async () => new Uint8Array([42, 5, 8, 150, 1, 16, 100]);
			return {
				agentId: "agent-occupancy", close() {}, async [Symbol.asyncDispose]() {},
				async send() {
					root = "fresh";
					return { id: "run-occupancy", agentId: "agent-occupancy", supports: () => false,
						wait: async () => ({ id: "run-occupancy", status: "finished", result: "answer" }) } as Run;
				},
			} as SDKAgent;
		});
		const controller = new AbortController();
		const pending = drain(cursorModel("composer-2.5", 200_000), userContext("hi"), {
			apiKey: "test-key",
			signal: controller.signal,
			[HOST_BRIDGE_OPTION_KEY]: host,
		} as SimpleStreamOptions);
		await started.promise;
		controller.abort();
		release.resolve();
		const last = (await pending).at(-1);
		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("Expected aborted turn");
		expect(last.error.usage.contextTokens).toBeUndefined();
		expect(last.error.cursorSdk.contextOccupancy).toEqual({ status: "unavailable" });
		expect(host.bindings).toEqual([]);
	});

	test("abort at occupancy store read does not publish occupancy", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let root = "baseline";
		let afterSend = false;
		runtimeTestUtils.setOpenAgent(async (input) => {
			input.store.agents.get = async () => {
				if (afterSend) {
					started.resolve();
					await release.promise;
				}
				return {
					agentId: "agent-occupancy", cwd: input.cwd, status: "idle" as const, createdAt: 1, updatedAt: 2,
					latestCheckpoint: { schemaVersion: 1 as const, rootBlobId: root },
				};
			};
			input.store.checkpoints.get = async () => new Uint8Array([42, 5, 8, 150, 1, 16, 100]);
			return {
				agentId: "agent-occupancy", close() {}, async [Symbol.asyncDispose]() {},
				async send() {
					root = "fresh";
					afterSend = true;
					return { id: "run-occupancy", agentId: "agent-occupancy", supports: () => false,
						wait: async () => ({ id: "run-occupancy", status: "finished", result: "answer" }) } as Run;
				},
			} as SDKAgent;
		});
		const controller = new AbortController();
		const pending = drain(cursorModel("composer-2.5", 200_000), userContext("hi"), {
			apiKey: "test-key",
			signal: controller.signal,
		});
		await started.promise;
		controller.abort();
		release.resolve();
		const last = (await pending).at(-1);
		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("Expected aborted turn");
		expect(last.error.usage.contextTokens).toBeUndefined();
		expect(last.error.cursorSdk.contextOccupancy).toEqual({ status: "unavailable" });
	});

	test("same-session supersede during commitBinding keeps B's binding and occupancy", async () => {
		const hostA = createFakeHost({ tools: [] });
		const hostB = createFakeHost({ tools: [] });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		hostA.commitBinding = async () => { started.resolve(); await release.promise; };
		let n = 0;
		runtimeTestUtils.setOpenAgent(async (input) => {
			const agentId = `agent-${++n}`;
			input.store.agents.get = async () => ({
				agentId, cwd: input.cwd, status: "idle" as const, createdAt: 1, updatedAt: 2,
				latestCheckpoint: { schemaVersion: 1 as const, rootBlobId: agentId === "agent-1" ? "stale" : "fresh" },
			});
			input.store.checkpoints.get = async () => new Uint8Array([42, 5, 8, 150, 1, 16, 100]);
			return {
				agentId, close() {}, async [Symbol.asyncDispose]() {},
				async send() {
					return { id: `run-${agentId}`, agentId, supports: () => false,
						wait: async () => ({ id: `run-${agentId}`, status: "finished", result: agentId === "agent-1" ? "A" : "B" }) } as Run;
				},
			} as SDKAgent;
		});
		const a = drain(cursorModel("composer-2.5", 200_000), userContext("A"), {
			apiKey: "test-key",
			[HOST_BRIDGE_OPTION_KEY]: hostA,
		} as SimpleStreamOptions);
		await started.promise;
		const b = await drain(cursorModel("composer-2.5", 200_000), userContext("B"), {
			apiKey: "test-key",
			[HOST_BRIDGE_OPTION_KEY]: hostB,
		} as SimpleStreamOptions);
		release.resolve();
		const aLast = (await a).at(-1);
		expect(aLast?.type).toBe("error");
		if (aLast?.type !== "error") throw new Error("Expected superseded A");
		expect(aLast.error.usage.contextTokens).toBeUndefined();
		expect(hostA.bindings).toEqual([]);
		const bLast = b.at(-1);
		expect(bLast).toMatchObject({ type: "done", reason: "stop" });
		expect(hostB.bindings).toHaveLength(1);
		expect(hostB.bindings[0]?.sdkAgentId).toBe("agent-2");
	});

	test("contextTokens stay unobservable until commitBinding resolves while current", async () => {
		const host = createFakeHost({ tools: [] });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		host.commitBinding = async (binding) => {
			started.resolve();
			await release.promise;
			host.bindings.push(binding);
		};
		let root = "baseline";
		runtimeTestUtils.setOpenAgent(async (input) => {
			input.store.agents.get = async () => ({
				agentId: "agent-occupancy", cwd: input.cwd, status: "idle" as const, createdAt: 1, updatedAt: 2,
				latestCheckpoint: { schemaVersion: 1 as const, rootBlobId: root },
			});
			input.store.checkpoints.get = async () => new Uint8Array([42, 5, 8, 150, 1, 16, 100]);
			return {
				agentId: "agent-occupancy", close() {}, async [Symbol.asyncDispose]() {},
				async send() {
					root = "fresh";
					return {
						id: "run-occupancy", agentId: "agent-occupancy", supports: () => false,
						wait: async () => ({
							id: "run-occupancy", status: "finished", result: "answer",
							usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 23 },
						}),
					} as Run;
				},
			} as SDKAgent;
		});
		const events: Awaited<ReturnType<typeof drain>> = [];
		const pending = (async () => {
			for await (const event of streamCursorRuntime(cursorModel("composer-2.5", 200_000), userContext("hi"), {
				apiKey: "test-key",
				onPayload: scopeTestUtils.bindRequest,
				[HOST_BRIDGE_OPTION_KEY]: host,
			} as SimpleStreamOptions)) {
				events.push(event);
			}
		})();
		await started.promise;
		expect(events.some((event) => event.type === "done" || event.type === "error")).toBe(false);
		expect(events.some((event) => "message" in event && event.message.usage?.contextTokens != null)).toBe(false);
		release.resolve();
		await pending;
		const last = events.at(-1);
		expect(last).toMatchObject({
			type: "done",
			message: {
				usage: { totalTokens: 23, orchestration: { input: 20, output: 3 } },
				cursorSdk: { contextOccupancy: { status: "actual", source: "checkpoint" } },
			},
		});
		expect(last && "message" in last ? last.message.usage.contextTokens : undefined).toBeUndefined();
		expect(host.bindings).toHaveLength(1);
	});

	test("explicit host executeTool rejects on host.signal abort without commitBinding", async () => {
		const host = createFakeHost({ tools: ["read"] });
		const controller = new AbortController();
		host.signal = controller.signal;
		const entered = Promise.withResolvers<void>();
		const toolGate = Promise.withResolvers<{ content: { type: "text"; text: string }[]; isError: boolean }>();
		host.executeTool = async () => {
			const onAbort = () => toolGate.reject(new Error("host aborted"));
			host.signal.addEventListener("abort", onAbort, { once: true });
			if (host.signal.aborted) onAbort();
			return toolGate.promise;
		};
		runtimeTestUtils.setOpenAgent(async () => ({
			agentId: "agent-host",
			close() {},
			async [Symbol.asyncDispose]() {},
			async send(_message, options) {
				const tool = options?.local?.customTools?.read;
				if (!tool) throw new Error("read tool missing");
				void tool.execute({ path: "a.ts" }, { toolCallId: "call-host" }).catch(() => undefined);
				entered.resolve();
				return {
					supports: () => false,
					wait: () => new Promise<RunResult>(() => undefined),
				} as unknown as Run;
			},
		} as SDKAgent));
		const pending = drain(cursorModel("composer-2.5", 200_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			signal: controller.signal,
			[HOST_BRIDGE_OPTION_KEY]: host,
		} as SimpleStreamOptions);
		await entered.promise;
		void toolGate.promise.catch(() => undefined);
		controller.abort();
		const last = (await pending).at(-1);
		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("Expected aborted turn");
		expect(last.reason).toBe("aborted");
		expect(host.bindings).toEqual([]);
		await expect(toolGate.promise).rejects.toThrow(/host aborted/);
	});

	test("wait tool interrupt does not cancel the live SDK run", async () => {
		const host = createFakeHost({ tools: ["wait"], cwd: "/tmp/project", sessionId: "wait-sess" });
		const waitEntered = Promise.withResolvers<void>();
		const waitResult = Promise.withResolvers<{ content: { type: "text"; text: string }[]; isError: boolean }>();
		let cancelDuringWait = 0;
		let waitFinished = false;
		host.executeTool = async (name) => {
			if (name !== "wait") throw new Error(`unexpected ${name}`);
			waitEntered.resolve();
			return waitResult.promise;
		};
		runtimeTestUtils.setOpenAgent(async () => ({
			agentId: "wait-agent-1",
			close() {},
			async [Symbol.asyncDispose]() {},
			async send(_message, options) {
				const wait = options?.local?.customTools?.wait;
				if (!wait) throw new Error("wait tool missing");
				const pending = wait.execute({}, { toolCallId: "wait-1" });
				return {
					supports(capability: string) {
						return capability === "cancel";
					},
					async cancel() {
						if (!waitFinished) cancelDuringWait++;
					},
					async wait() {
						await waitEntered.promise;
						waitResult.reject(new Error("Wait interrupted by message."));
						await pending.catch(() => undefined);
						waitFinished = true;
						return { status: "finished", result: "continued" } as RunResult;
					},
				} as unknown as Run;
			},
		} as SDKAgent));
		const waitTool = {
			name: "wait",
			description: "wait",
			parameters: { type: "object", properties: {} },
		} as Tool;
		const events = await drain(cursorModel("composer-2.5", 200_000), userContext("park wait", [waitTool]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
			[HOST_BRIDGE_OPTION_KEY]: host,
		} as SimpleStreamOptions);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		expect(cancelDuringWait).toBe(0);
		expect(host.bindings).toHaveLength(1);
	});

	test("ungranted tools are not advertised and host executeTool rejects them", async () => {
		const host = createFakeHost({ tools: ["read"] });
		let names: string[] = [];
		runtimeTestUtils.setOpenAgent(async () => ({
			agentId: "agent-1",
			close() {},
			async [Symbol.asyncDispose]() {},
			async send(_message, options) {
				names = Object.keys(options?.local?.customTools ?? {});
				return finishedRun();
			},
		} as SDKAgent));
		await drain(cursorModel("composer-2.5", 200_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			[HOST_BRIDGE_OPTION_KEY]: host,
		} as SimpleStreamOptions);
		expect(names).toEqual(["read"]);
		await expect(host.executeTool("write", { path: "x.ts" }, "call-x")).rejects.toThrow(/not granted/);
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

	test("granted custom tools reach openAgent as customTools and toolNameMap", async () => {
		let customTools: string[] = [];
		let toolNameMap: Array<[string, string]> | undefined;
		runtimeTestUtils.setOpenAgent(async (input) => {
			customTools = Object.keys(input.customTools);
			toolNameMap = input.toolNameMap ? [...input.toolNameMap.entries()] : undefined;
			return {
				agentId: "agent-1",
				close() {},
				async [Symbol.asyncDispose]() {},
				async send() { return finishedRun(); },
			} as unknown as SDKAgent;
		});
		const tool = {
			name: "read file",
			description: "search",
			parameters: { type: "object", properties: { query: { type: "string" } } },
		} as Tool;
		await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [tool]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		const sdkName = mapOmpToolName("read file");
		expect(customTools).toEqual([sdkName]);
		expect(toolNameMap).toEqual([["read file", sdkName]]);
	});

	test("host snapshot without tools ignores context.tools", async () => {
		let customTools: string[] = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			customTools = Object.keys(input.customTools);
			return {
				agentId: "agent-1",
				close() {},
				async [Symbol.asyncDispose]() {},
				async send() { return finishedRun(); },
			} as unknown as SDKAgent;
		});
		await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
			[HOST_BRIDGE_OPTION_KEY]: createFakeHost({ tools: [] }),
		} as SimpleStreamOptions);
		expect(customTools).toEqual([]);
	});

	test.each(["disableReasoning", "forceReasoningOff"] as const)("%s wins over reasoning and still uses catalog context threshold", async (offOption) => {
		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		installCapturingAgent(created, sent);
		const model = cursorModel("composer-2.5", 200_000);
		const expected: ModelSelection = {
			id: "composer-2.5",
			params: [
				{ id: "fast", value: "false" },
				{ id: "context", value: "200k" },
				{ id: "reasoning", value: "none" },
			],
		};
		await drain(model, userContext("hi"), {
			apiKey: "test-key",
			cwd: "/tmp/project",
			reasoning: Effort.High,
			[offOption]: true,
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

	test("MCP tool-call-started preview is closed by the parked callback", async () => {
		installCapturingAgent([], [], async (options) => {
			const tool = options?.local?.customTools?.read;
			if (!tool) return finishedRun();
			await options?.onDelta?.({
				update: {
					type: "tool-call-started",
					callId: "call-1",
					modelCallId: "model-1",
					toolCall: { type: "mcp", args: { toolName: "read", providerIdentifier: "custom-user-tools", args: { path: "a.ts" } } },
				},
			});
			const pending = tool.execute({ path: "a.ts" }, { toolCallId: "call-1" });
			return {
				id: "run-preview",
				supports: () => false,
				wait: async () => {
					await pending;
					return { id: "run-preview", status: "finished", result: "done" } as RunResult;
				},
			} as unknown as Run;
		});
		const events = await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected toolUse");
		expect(done.message.content.filter((block) => block.type === "toolCall")).toEqual([
			expect.objectContaining({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }),
		]);
	});

	test("projects 87-char SDK IDs into OMP yield and resumes on the portable ID", async () => {
		const sdkId = `${"x".repeat(64)}${"y".repeat(23)}`;
		const ompId = projectSdkToolCallId(sdkId);
		installCapturingAgent([], [], async (options) => {
			const tool = options?.local?.customTools?.read;
			if (!tool) return finishedRun();
			const pending = tool.execute({ path: "a.ts" }, { toolCallId: sdkId });
			return {
				id: "run-long-id",
				supports: () => false,
				wait: async () => {
					await pending;
					return { id: "run-long-id", status: "finished", result: "done" } as RunResult;
				},
			} as unknown as Run;
		});
		const first = await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		expect(first.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
		const done = first.at(-1);
		if (done?.type !== "done") throw new Error("expected toolUse");
		expect(done.message.content.filter((block) => block.type === "toolCall")).toEqual([
			expect.objectContaining({ type: "toolCall", id: ompId, name: "read", arguments: { path: "a.ts" } }),
		]);
		expect(ompId).not.toBe(sdkId);
		expect(ompId.length).toBeLessThanOrEqual(64);
		const second = await drain(
			cursorModel("composer-2.5", 1_000_000),
			{
				messages: [
					{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number],
					{
						role: "toolResult",
						toolCallId: ompId,
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 2,
					},
				],
				tools: [readTool()],
			} as Context,
			{ apiKey: "test-key", cwd: "/tmp/project" },
		);
		expect(second.at(-1)).toMatchObject({ type: "done", reason: "stop" });
	});

	test("host executeTool receives the portable ID, not the 87-char SDK ID", async () => {
		const host = createFakeHost({ tools: ["read"] });
		const sdkId = `${"x".repeat(64)}${"y".repeat(23)}`;
		const ompId = projectSdkToolCallId(sdkId);
		installCapturingAgent([], [], async (options) => {
			const tool = options?.local?.customTools?.read;
			if (!tool) return finishedRun();
			await tool.execute({ path: "a.ts" }, { toolCallId: sdkId });
			return {
				id: "run-host-long",
				supports: () => false,
				wait: async () => ({ id: "run-host-long", status: "finished", result: "done" }) as RunResult,
			} as unknown as Run;
		});
		await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
			[HOST_BRIDGE_OPTION_KEY]: host,
		} as SimpleStreamOptions);
		expect(host.calls).toEqual([{ name: "read", args: { path: "a.ts" }, toolCallId: ompId }]);
		expect(host.calls[0]?.toolCallId).not.toBe(sdkId);
		expect(host.calls[0]?.toolCallId.length).toBeLessThanOrEqual(64);
	});

	test("host-executed tools do not leave preview toolCalls for OMP to run again", async () => {
		const host = createFakeHost({ tools: ["read"] });
		installCapturingAgent([], [], async (options) => {
			const tool = options?.local?.customTools?.read;
			if (!tool) return finishedRun();
			await options?.onDelta?.({
				update: {
					type: "tool-call-started",
					callId: "call-1",
					modelCallId: "model-1",
					toolCall: { type: "mcp", args: { toolName: "read", providerIdentifier: "custom-user-tools", args: { path: "a.ts" } } },
				},
			});
			await tool.execute({ path: "a.ts" }, { toolCallId: "call-1" });
			return {
				id: "run-host",
				supports: () => false,
				wait: async () => ({ id: "run-host", status: "finished", result: "done" }) as RunResult,
			} as unknown as Run;
		});
		const events = await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
			[HOST_BRIDGE_OPTION_KEY]: host,
		} as SimpleStreamOptions);
		expect(host.calls).toEqual([{ name: "read", args: { path: "a.ts" }, toolCallId: "call-1" }]);
		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(0);
		const done = events.at(-1);
		expect(done).toMatchObject({ type: "done", reason: "stop" });
		if (done?.type !== "done") throw new Error("expected stop");
		expect(done.message.content.some((block) => block.type === "toolCall")).toBe(false);
	});

	test("a dropped preview still yields when its callback parks on the next message", async () => {
		installCapturingAgent([], [], async (options) => {
			const tool = options?.local?.customTools?.read;
			if (!tool) return finishedRun();
			await options?.onDelta?.({
				update: {
					type: "tool-call-started",
					callId: "call-B",
					modelCallId: "model-B",
					toolCall: { type: "mcp", args: { toolName: "read", providerIdentifier: "custom-user-tools", args: { path: "b.ts" } } },
				},
			});
			const pendingA = tool.execute({ path: "a.ts" }, { toolCallId: "call-A" });
			return {
				id: "run-ab",
				supports: () => false,
				wait: async () => {
					await pendingA;
					const pendingB = tool.execute({ path: "b.ts" }, { toolCallId: "call-B" });
					await pendingB;
					return { id: "run-ab", status: "finished", result: "done" } as RunResult;
				},
			} as unknown as Run;
		});
		const first = await drain(cursorModel("composer-2.5", 1_000_000), userContext("hi", [readTool()]), {
			apiKey: "test-key",
			cwd: "/tmp/project",
		});
		expect(first.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
		const firstDone = first.at(-1);
		if (firstDone?.type !== "done") throw new Error("expected A");
		expect(firstDone.message.content.filter((block) => block.type === "toolCall")).toEqual([
			expect.objectContaining({ type: "toolCall", id: "call-A", name: "read", arguments: { path: "a.ts" } }),
		]);
		const second = await drain(
			cursorModel("composer-2.5", 1_000_000),
			{
				messages: [
					{ role: "user", content: "hi", timestamp: 1 } as Context["messages"][number],
					{
						role: "toolResult",
						toolCallId: "call-A",
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 2,
					},
				],
				tools: [readTool()],
			} as Context,
			{ apiKey: "test-key", cwd: "/tmp/project" },
		);
		expect(second.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
		expect(second.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
		const secondDone = second.at(-1);
		expect(secondDone).toMatchObject({ type: "done", reason: "toolUse" });
		if (secondDone?.type !== "done") throw new Error("expected B");
		expect(secondDone.message.content.filter((block) => block.type === "toolCall")).toEqual([
			expect.objectContaining({ type: "toolCall", id: "call-B", name: "read", arguments: { path: "b.ts" } }),
		]);
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

	test.each(["prefix", "request", "result", "images"])("fails recovery rather than dropping its required oversized %s", async (oversized) => {
		const context = recordedToolContext();
		if (oversized === "prefix") {
			context.messages.unshift(
				{ role: "user", content: "Earlier request " + "x".repeat(20_000), timestamp: -1 } as Context["messages"][number],
				{ role: "assistant", content: [{ type: "text", text: "Earlier answer" }], timestamp: 0 } as Context["messages"][number],
			);
		} else if (oversized === "request") {
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
		expect(events.at(-1)).toMatchObject({ type: "error", error: { errorMessage: expect.stringMatching(/cannot restore the current tool turn[\s\S]*\/compact/i) } });
		expect(created).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("bootstrap budget refusal leaves the committed host binding and agent untouched", async () => {
		const host = createFakeHost({ tools: [], cwd: "/tmp/project", sessionId: "sess-1" });
		const sends: string[] = [];
		let opens = 0;
		let disposals = 0;
		runtimeTestUtils.setOpenAgent(async () => {
			opens += 1;
			return {
				agentId: "agent-old",
				close() {},
				async [Symbol.asyncDispose]() { disposals += 1; },
				async send() {
					sends.push("agent-old");
					return finishedRun();
				},
			} as SDKAgent;
		});
		const firstContext = userContext("first");
		const first = await drain(cursorModel("composer-2.5", 200_000), firstContext, {
			apiKey: "test-key",
			[HOST_BRIDGE_OPTION_KEY]: host,
		} as SimpleStreamOptions);
		expect(first.at(-1)).toMatchObject({ type: "done", reason: "stop" });
		const slot = [...runtimeTestUtils.slots.values()][0]!;
		const committedState = structuredClone(slot.sendState);
		const committedBindings = structuredClone(host.bindings);
		const oversizedDivergence = {
			messages: [
				...firstContext.messages,
				{
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(20_000) }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					timestamp: 2,
				},
				{ role: "user", content: "back to cursor", timestamp: 3 },
			],
		} as Context;
		const rejected = await drain(cursorModel("composer-2.5", 10_000), oversizedDivergence, {
			apiKey: "test-key",
			[HOST_BRIDGE_OPTION_KEY]: host,
		} as SimpleStreamOptions);
		expect(rejected.at(-1)).toMatchObject({
			type: "error",
			error: { errorMessage: expect.stringMatching(/\/compact/) },
		});
		expect(opens).toBe(1);
		expect(sends).toEqual(["agent-old"]);
		expect(disposals).toBe(0);
		expect(slot.agent?.agentId).toBe("agent-old");
		expect(slot.bindingState).toBe("committed");
		expect(slot.sendState).toEqual(committedState);
		expect(host.bindings).toEqual(committedBindings);
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
