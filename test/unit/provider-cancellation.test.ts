import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelListItem, Run, RunResult, SDKAgent, SendOptions } from "@cursor/sdk";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { HOST_BRIDGE_OPTION_KEY } from "../../src/host-option.ts";
import { streamCursorRuntime } from "../../src/provider.ts";
import { ensureCursorModels, __testUtils as catalogTestUtils } from "../../src/catalog.ts";
import * as runtime from "../../src/session-runtime.ts";
import { getLiveRun, __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils, ownerForContext, withCursorSessionOwner } from "../../src/session-scope.ts";
import { getMatchingResumeHandle, registerCursorSessionResume, __testUtils as resumeTestUtils } from "../../src/session-resume.ts";
import { registerCursorSessionLifecycle } from "../../src/session-lifecycle.ts";
import { createFakeHost } from "../helpers/fake-host.ts";

const ITEMS: ModelListItem[] = [{ id: "composer-2.5", displayName: "Composer 2.5" }];
const MODEL = { id: "composer-2.5", provider: CURSOR_SDK_PROVIDER_ID, api: CURSOR_SDK_API, contextWindow: 200_000, maxTokens: 8_192 } as Model<Api>;
const CONTEXT: Context = { messages: [{ role: "user", content: "request A", timestamp: 1 }] };
const TOOL_A = { name: "a", description: "a", parameters: { type: "object", properties: { path: { type: "string" } } } } as Tool;
const TOOL_B = { name: "b", description: "b", parameters: { type: "object", properties: { path: { type: "string" } } } } as Tool;
const PARK_CONTEXT: Context = {
	messages: [{ role: "user", content: "request A", timestamp: 1 }],
	tools: [TOOL_A, TOOL_B],
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function collect(options: SimpleStreamOptions, context = CONTEXT) {
	return (async () => {
		const events: AssistantMessageEvent[] = [];
		for await (const event of streamCursorRuntime(MODEL, context, { ...options, onPayload: options.onPayload ?? scopeTestUtils.bindRequest })) events.push(event);
		return events;
	})();
}

function expectAborted(events: AssistantMessageEvent[]) {
	const terminal = events.filter((event) => event.type === "error" || event.type === "done");
	expect(terminal).toHaveLength(1);
	expect(terminal[0]).toMatchObject({ type: "error", reason: "aborted", error: { stopReason: "aborted" } });
}

// A deadline only rejects a stuck stream; it never makes a timing assertion pass.
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("stream did not finish before catalog settlement")), 1000);
		})]);
	} finally {
		clearTimeout(timer);
	}
}

async function awaitEntered(entered: Promise<void>, stream: Promise<AssistantMessageEvent[]>) {
	await bounded(Promise.race([
		entered,
		stream.then((events) => {
			throw new Error(`stream ended before entering deferred operation: ${JSON.stringify(events)}`);
		}),
	]));
}

// Queue behind discovery, then drain its provider continuations, including failure cleanup.
async function discoverySettled() {
	await ensureCursorModels("test-key").catch(() => undefined);
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("provider cancellation before prepareTurn", () => {
	let cwd: string;
	let opens: string[];
	let sends: string[];
	let disposals: string[];
	let writes: unknown[];
	let prepare: ReturnType<typeof spyOn<typeof runtime, "prepareTurn">>;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "omp-cancel-"));
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		scopeTestUtils.set(cwd, join(cwd, "A.jsonl"), "A");
		resumeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		opens = [];
		sends = [];
		disposals = [];
		writes = [];
		resumeTestUtils.state.appendEntry = (_type, data) => { writes.push(data); };
		runtime.__testUtils.setOpenAgent(async () => {
			const agentId = `fake-agent-${opens.length + 1}`;
			opens.push(agentId);
			return {
				agentId,
				close() { disposals.push(agentId); },
				async [Symbol.asyncDispose]() { disposals.push(agentId); },
				async send() {
					sends.push(agentId);
					return { supports: () => false, wait: async (): Promise<RunResult> => ({ status: "finished" }) as RunResult } as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
		prepare = spyOn(runtime, "prepareTurn");
	});

	afterEach(() => {
		prepare.mockRestore();
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		resumeTestUtils.reset();
		scopeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		rmSync(cwd, { recursive: true, force: true });
	});

	function request(signal: AbortSignal) {
		const host = createFakeHost({ cwd, sessionId: "A", tools: [] });
		host.signal = signal;
		return { host, options: { apiKey: "test-key", [HOST_BRIDGE_OPTION_KEY]: host } as SimpleStreamOptions };
	}

	function expectUntouched() {
		expect(prepare).not.toHaveBeenCalled();
		expect(runtime.__testUtils.slots.size).toBe(0);
		expect(opens).toEqual([]);
		expect(sends).toEqual([]);
		expect(disposals).toEqual([]);
		expect(writes).toEqual([]);
		expect(resumeTestUtils.state.pendingHandle).toBeUndefined();
	}

	test("late cancelled run events and completion cannot corrupt a newer route", async () => {
		catalogTestUtils.setListModels(async () => ITEMS);
		const entered = deferred<void>();
		const oldResult = deferred<RunResult>();
		let oldDelta: SendOptions["onDelta"];
		runtime.__testUtils.setOpenAgent(async () => {
			const agentId = `agent-${opens.length + 1}`;
			opens.push(agentId);
			return {
				agentId,
				async [Symbol.asyncDispose]() {},
				async send(_message: unknown, options?: SendOptions) {
					sends.push(agentId);
					if (agentId === "agent-1") {
						oldDelta = options?.onDelta;
						entered.resolve();
						return { supports: () => false, wait: () => oldResult.promise } as unknown as Run;
					}
					return { supports: () => false, wait: async () => ({ status: "finished", result: "new answer" }) } as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
		const oldHost = createFakeHost({ cwd, sessionId: "A", tools: [] });
		const newerHost = createFakeHost({ cwd, sessionId: "A", tools: [] });
		const old = collect({ apiKey: "test-key", [HOST_BRIDGE_OPTION_KEY]: oldHost } as SimpleStreamOptions);
		await awaitEntered(entered.promise, old);
		const newer = await bounded(collect(
			{ apiKey: "test-key", [HOST_BRIDGE_OPTION_KEY]: newerHost } as SimpleStreamOptions,
			{ messages: [{ role: "user", content: "new request", timestamp: 2 }] },
		));
		expectAborted(await bounded(old));
		const pending = structuredClone(resumeTestUtils.state.pendingHandle);
		await oldDelta?.({ update: { type: "text-delta", text: "stale answer" } });
		oldResult.resolve({ status: "finished", result: "stale answer" } as RunResult);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(oldHost.bindings).toEqual([]);
		expect(newerHost.bindings).toHaveLength(1);
		expect(newer.filter((event) => event.type === "done")).toMatchObject([{ reason: "stop" }]);
		expect(sends).toEqual(["agent-1", "agent-2"]);
		expect([...runtime.__testUtils.slots.values()][0]?.agent?.agentId).toBe("agent-2");
		expect(resumeTestUtils.state.pendingHandle).toEqual(pending);
	});

	for (const source of ["options", "host"] as const) {
		test(`pre-aborted ${source} signal skips cold discovery and runtime mutation`, async () => {
			let discoveries = 0;
			catalogTestUtils.setListModels(async () => { discoveries++; return ITEMS; });
			const controller = new AbortController();
			controller.abort();
			const { host, options } = request(controller.signal);
			// Host cancellation takes precedence even when options has a live signal.
			const input = source === "host" ? { ...options, signal: new AbortController().signal } : { apiKey: "test-key", signal: controller.signal };
			expectAborted(await bounded(collect(input)));
			expect(discoveries).toBe(0);
			expect(host.bindings).toEqual([]);
			expectUntouched();
		});
	}

	test("pre-aborted parked continuation never enters prepareTurn", async () => {
		let discoveries = 0;
		catalogTestUtils.setListModels(async () => { discoveries++; return ITEMS; });
		const controller = new AbortController();
		controller.abort();
		const context = { messages: [{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 }] } as Context;
		expectAborted(await bounded(collect({ apiKey: "test-key", signal: controller.signal }, context)));
		expect(discoveries).toBe(0);
		expectUntouched();
	});

	for (const settlement of ["resolve", "reject"] as const) {
		test(`abort ends pending discovery before late ${settlement} and preserves committed session B`, async () => {
			const entered = deferred<void>();
			const catalog = deferred<readonly ModelListItem[]>();
			catalogTestUtils.setListModels(() => { entered.resolve(); return catalog.promise; });
			const controller = new AbortController();
			const { host, options } = request(controller.signal);
			const ended = collect(options);
			try {
				await awaitEntered(entered.promise, ended);
				controller.abort();
				// Catalog has not been resolved/rejected: completion must be independent of it.
				expectAborted(await bounded(ended));
				expectUntouched();

				const sessionFile = join(cwd, "B.jsonl");
				scopeTestUtils.set(cwd, sessionFile, "B");
				const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
				registerCursorSessionResume({
					on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
					appendEntry(_type: string, data: unknown) { writes.push(data); },
				} as never);
				const ctx = { cwd, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "B", getBranch: () => [], getEntries: () => [] } };
				await handlers.get("session_start")!({}, ctx);
				const contextB: Context = { messages: [{ role: "user", content: "committed B", timestamp: 2 }] };
				const prepared = await runtime.prepareTurn({ cwd, agentInstanceId: "main", apiKey: "test-key", modelSelection: { id: MODEL.id }, modelLimits: { contextWindow: MODEL.contextWindow, maxTokens: MODEL.maxTokens }, context: contextB, grantedTools: [] });
				runtime.commitTurn(prepared.slot, contextB, false);
				await runtime.finishLiveKeepAgent(prepared.slot, "seed B");
				await handlers.get("turn_end")!({}, ctx);
				const handle = getMatchingResumeHandle("main", prepared.slot.credentialScopeId, cwd);
				expect(handle).toMatchObject({ state: "committed", sessionId: "B", agentId: prepared.slot.agent!.agentId });
				const slotBefore = { ...prepared.slot, sendState: { ...prepared.slot.sendState } };
				const writesBefore = structuredClone(writes);
				const opensBefore = [...opens];
				const disposalsBefore = [...disposals];
				prepare.mockClear();

				if (settlement === "resolve") catalog.resolve(ITEMS);
				else catalog.reject(new Error("late catalog failure"));
				await discoverySettled();
				expectAborted(await ended);
				expect(prepare).not.toHaveBeenCalled();
				expect([...runtime.__testUtils.slots.values()]).toEqual([slotBefore]);
				expect(prepared.slot.agent).toBe(slotBefore.agent);
				expect(getMatchingResumeHandle("main", prepared.slot.credentialScopeId, cwd)).toEqual(handle);
				expect(resumeTestUtils.state.pendingHandle).toBeUndefined();
				expect(writes).toEqual(writesBefore);
				expect(opens).toEqual(opensBefore);
				expect(sends).toEqual([]);
				expect(disposals).toEqual(disposalsBefore);
				expect(host.bindings).toEqual([]);
			} finally {
				catalog.resolve(ITEMS);
				await discoverySettled();
				await ended;
			}
		});
	}

	test("same-turn discovery failure and abort is classified as aborted", async () => {
		const entered = deferred<void>();
		const catalog = deferred<readonly ModelListItem[]>();
		catalogTestUtils.setListModels(() => { entered.resolve(); return catalog.promise; });
		const controller = new AbortController();
		const ended = collect({ apiKey: "test-key", signal: controller.signal });
		await awaitEntered(entered.promise, ended);
		catalog.reject(new Error("discovery failed first"));
		controller.abort();
		expectAborted(await bounded(ended));
		await discoverySettled();
		expectUntouched();
	});

	test("cancelling one provider waiter leaves shared discovery available to another", async () => {
		const entered = deferred<void>();
		const catalog = deferred<readonly ModelListItem[]>();
		let discoveries = 0;
		catalogTestUtils.setListModels(() => { discoveries++; entered.resolve(); return catalog.promise; });
		const controller = new AbortController();
		const { host, options } = request(controller.signal);
		const cancelled = collect(options);
		await awaitEntered(entered.promise, cancelled);
		const survivor = collect({ apiKey: "test-key" });
		try {
			controller.abort();
			expectAborted(await bounded(cancelled));
			expectUntouched();
			catalog.resolve(ITEMS);
			const events = await bounded(survivor);
			expect(events.filter((event) => event.type === "error" || event.type === "done")).toMatchObject([{ type: "done", reason: "stop" }]);
			expect(discoveries).toBe(1);
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(opens).toEqual(["fake-agent-1"]);
			expect(sends).toEqual(["fake-agent-1"]);
			expect(host.bindings).toEqual([]);
		} finally {
			catalog.resolve(ITEMS);
			await Promise.all([cancelled, survivor]);
		}
	});
});

function expectOneTerminal(events: AssistantMessageEvent[]) {
	const terminal = events.filter((event) => event.type === "error" || event.type === "done");
	expect(terminal).toHaveLength(1);
	return terminal[0];
}

function toolResultMessage(toolCallId: string, name: string): Context["messages"][number] {
	return {
		role: "toolResult",
		toolCallId,
		toolName: name,
		content: [{ type: "text", text: `ok:${name}` }],
		isError: false,
		timestamp: 3,
	};
}

describe("provider late events after park and abort", () => {
	let cwd: string;
	let opens: string[];
	let sends: string[];

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "omp-cancel-park-"));
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		scopeTestUtils.set(cwd, join(cwd, "A.jsonl"), "A");
		resumeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setListModels(async () => ITEMS);
		opens = [];
		sends = [];
	});

	afterEach(() => {
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		resumeTestUtils.reset();
		scopeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		rmSync(cwd, { recursive: true, force: true });
	});

	function owned(options: SimpleStreamOptions): SimpleStreamOptions {
		return { ...options, cwd, onPayload: scopeTestUtils.bindRequest };
	}

	type Late = "handle" | "delta" | "finished" | "result-a" | "result-b";

	test.each([
		[["handle", "delta", "finished", "result-a", "result-b"] as Late[]],
		[["result-b", "delta", "handle", "result-a", "finished"] as Late[]],
	])("stale A events after toolUse abort cannot rewrite B %j", async (order) => {
		const sendA = deferred<Run>();
		const waitA = deferred<RunResult>();
		let onDelta: SendOptions["onDelta"];
		const parks: Promise<unknown>[] = [];
		runtime.__testUtils.setOpenAgent(async () => {
			const agentId = `agent-${opens.length + 1}`;
			opens.push(agentId);
			return {
				agentId,
				async [Symbol.asyncDispose]() {},
				async send(_message: unknown, options?: SendOptions) {
					sends.push(agentId);
					if (agentId !== "agent-1") {
						return {
							supports: () => false,
							wait: async () => ({ status: "finished", result: "B answer" }) as RunResult,
						} as unknown as Run;
					}
					onDelta = options?.onDelta;
					const tools = options?.local?.customTools ?? {};
					parks.push(tools.a.execute({ path: "a.ts" }, { toolCallId: "call-a" }));
					parks.push(tools.b.execute({ path: "b.ts" }, { toolCallId: "call-b" }));
					return await sendA.promise;
				},
			} as unknown as SDKAgent;
		});
		const controller = new AbortController();
		const aEventsP = collect(owned({ apiKey: "test-key", signal: controller.signal }), PARK_CONTEXT);
		const aEvents = await bounded(aEventsP);
		const aTerminal = expectOneTerminal(aEvents);
		expect(aTerminal).toMatchObject({ type: "done", reason: "toolUse" });
		if (aTerminal.type !== "done") throw new Error("expected toolUse");
		const live = getLiveRun(runtime.runtimeKey());
		expect(live?.cancelled).toBe(false);
		expect(live?.parked.map((call) => call.sdkToolCallId)).toEqual(["call-a", "call-b"]);
		expect(live?.agent?.agentId).toBe("agent-1");
		controller.abort();
		await Promise.allSettled(parks);
		expect(live?.cancelled).toBe(true);
		for (const park of parks) await expect(park).rejects.toThrow(/cancelled/);

		const bHost = createFakeHost({ cwd, sessionId: "A", tools: [] });
		const bEventsP = collect(owned({
			apiKey: "test-key",
			[HOST_BRIDGE_OPTION_KEY]: bHost,
		} as SimpleStreamOptions), { messages: [{ role: "user", content: "request B", timestamp: 2 }] });

		for (const step of order) {
			if (step === "handle") {
				sendA.resolve({
					supports: () => false,
					wait: () => waitA.promise,
				} as unknown as Run);
			} else if (step === "delta") {
				await onDelta?.({ update: { type: "text-delta", text: "stale A" } });
			} else if (step === "finished") {
				waitA.resolve({ status: "finished", result: "stale A" } as RunResult);
			} else if (step === "result-a" || step === "result-b") {
				const id = step === "result-a" ? "call-a" : "call-b";
				await bounded(collect(owned({ apiKey: "test-key" }), {
					messages: [
						PARK_CONTEXT.messages[0]!,
						aTerminal.message,
						toolResultMessage(id, id === "call-a" ? "a" : "b"),
					],
					tools: PARK_CONTEXT.tools,
				}));
			}
		}
		if (!sendA.promise) sendA.resolve({ supports: () => false, wait: () => waitA.promise } as unknown as Run);
		waitA.resolve({ status: "cancelled" } as RunResult);

		const bEvents = await bounded(bEventsP);
		const bTerminal = expectOneTerminal(bEvents);
		expect(bTerminal).toMatchObject({ type: "done", reason: "stop" });
		if (bTerminal.type !== "done") throw new Error("expected B stop");
		expect(JSON.stringify(bTerminal.message.content)).not.toContain("stale A");
		expect(bHost.bindings).toHaveLength(1);
		expect(bHost.bindings[0]?.sdkAgentId).toBe("agent-2");
		expect(bTerminal.message.usage.contextTokens).toBeUndefined();
	});

	test("stale A continuation cannot cancel newer parked B", async () => {
		const waitA = deferred<RunResult>();
		const waitB = deferred<RunResult>();
		const parks: Promise<unknown>[] = [];
		runtime.__testUtils.setOpenAgent(async () => {
			const agentId = `agent-${opens.length + 1}`;
			opens.push(agentId);
			return {
				agentId,
				async [Symbol.asyncDispose]() {},
				async send(_message: unknown, options?: SendOptions) {
					sends.push(agentId);
					const tools = options?.local?.customTools ?? {};
					if (agentId === "agent-1") {
						parks.push(tools.a.execute({ path: "a.ts" }, { toolCallId: "call-a" }));
						return { supports: () => false, wait: () => waitA.promise } as unknown as Run;
					}
					const execution = tools.b.execute({ path: "b.ts" }, { toolCallId: "call-b" });
					parks.push(execution);
					void execution.then(
						() => waitB.resolve({ status: "finished", result: "B answer" } as RunResult),
						waitB.reject,
					);
					return { supports: () => false, wait: () => waitB.promise } as unknown as Run;
				},
			} as unknown as SDKAgent;
		});

		const controller = new AbortController();
		const aEvents = await bounded(collect(owned({ apiKey: "test-key", signal: controller.signal }), {
			messages: [PARK_CONTEXT.messages[0]!],
			tools: [TOOL_A],
		}));
		const aTerminal = expectOneTerminal(aEvents);
		expect(aTerminal).toMatchObject({ type: "done", reason: "toolUse" });
		if (aTerminal.type !== "done") throw new Error("expected A toolUse");
		controller.abort();
		await Promise.allSettled(parks);

		const bContext: Context = {
			messages: [{ role: "user", content: "request B", timestamp: 2 }],
			tools: [TOOL_B],
		};
		const bParkedEvents = await bounded(collect(owned({ apiKey: "test-key" }), bContext));
		const bParkedTerminal = expectOneTerminal(bParkedEvents);
		expect(bParkedTerminal).toMatchObject({ type: "done", reason: "toolUse" });
		if (bParkedTerminal.type !== "done") throw new Error("expected B toolUse");
		const bLive = getLiveRun(runtime.runtimeKey());
		expect(bLive?.parked.map((call) => call.sdkToolCallId)).toEqual(["call-b"]);
		expect(bLive?.cancelled).toBe(false);

		const staleEvents = await bounded(collect(owned({ apiKey: "test-key" }), {
			messages: [
				PARK_CONTEXT.messages[0]!,
				aTerminal.message,
				toolResultMessage("call-a", "a"),
			],
			tools: [TOOL_A],
		}));
		expect(expectOneTerminal(staleEvents)).toMatchObject({ type: "error", reason: "error" });
		expect(getLiveRun(runtime.runtimeKey())).toBe(bLive);
		expect(bLive?.parked.map((call) => call.sdkToolCallId)).toEqual(["call-b"]);
		expect(bLive?.cancelled).toBe(false);

		const bEvents = await bounded(collect(owned({ apiKey: "test-key" }), {
			messages: [
				bContext.messages[0]!,
				bParkedTerminal.message,
				toolResultMessage("call-b", "b"),
			],
			tools: [TOOL_B],
		}));
		expect(expectOneTerminal(bEvents)).toMatchObject({ type: "done", reason: "stop" });
		expect(JSON.stringify(bEvents)).toContain("B answer");
	});

	test("abort before send handle and terminal then start B isolates late A events", async () => {
		const sendA = deferred<Run>();
		const waitA = deferred<RunResult>();
		const entered = deferred<void>();
		let onDelta: SendOptions["onDelta"];
		runtime.__testUtils.setOpenAgent(async () => {
			const agentId = `agent-${opens.length + 1}`;
			opens.push(agentId);
			return {
				agentId,
				async [Symbol.asyncDispose]() {},
				async send(_message: unknown, options?: SendOptions) {
					sends.push(agentId);
					if (agentId !== "agent-1") {
						return {
							supports: () => false,
							wait: async () => ({ status: "finished", result: "B answer" }) as RunResult,
						} as unknown as Run;
					}
					onDelta = options?.onDelta;
					entered.resolve();
					return await sendA.promise;
				},
			} as unknown as SDKAgent;
		});
		const controller = new AbortController();
		const aEventsP = collect(owned({ apiKey: "test-key", signal: controller.signal }));
		await awaitEntered(entered.promise, aEventsP);
		controller.abort();
		expectAborted(await bounded(aEventsP));

		const bHost = createFakeHost({ cwd, sessionId: "A", tools: [] });
		const bEventsP = collect(owned({
			apiKey: "test-key",
			[HOST_BRIDGE_OPTION_KEY]: bHost,
		} as SimpleStreamOptions), { messages: [{ role: "user", content: "request B", timestamp: 2 }] });
		sendA.resolve({
			supports: () => false,
			wait: () => waitA.promise,
		} as unknown as Run);
		await onDelta?.({ update: { type: "text-delta", text: "stale A" } });
		waitA.resolve({ status: "finished", result: "stale A" } as RunResult);
		const bEvents = await bounded(bEventsP);
		const bTerminal = expectOneTerminal(bEvents);
		expect(bTerminal).toMatchObject({ type: "done", reason: "stop" });
		expect(JSON.stringify(bEvents)).not.toContain("stale A");
		expect(bHost.bindings).toHaveLength(1);
		expect(bHost.bindings[0]?.sdkAgentId).toBe("agent-2");
	});
});

describe("provider session events reject parked work", () => {
	let cwd: string;
	let opens: string[];
	let saved: Array<string | undefined>;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "omp-session-event-"));
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		scopeTestUtils.set(cwd, join(cwd, "A.jsonl"), "A");
		resumeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setListModels(async () => ITEMS);
		opens = [];
		saved = [];
		runtime.__testUtils.setOpenAgent(async (input) => {
			saved.push(input.savedAgentId);
			const agentId = `agent-${opens.length + 1}`;
			opens.push(agentId);
			return {
				agentId,
				async [Symbol.asyncDispose]() {},
				async send(_message: unknown, options?: SendOptions) {
					const tools = options?.local?.customTools ?? {};
					if (tools.a) {
						void tools.a.execute({ path: "a.ts" }, { toolCallId: "call-a" }).catch(() => undefined);
						await new Promise<Run>(() => undefined);
					}
					return { supports: () => false, wait: async () => ({ status: "finished", result: "ok" }) as RunResult } as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
	});

	afterEach(() => {
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		resumeTestUtils.reset();
		scopeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		rmSync(cwd, { recursive: true, force: true });
	});

	function hooks() {
		const sessionFile = join(cwd, "A.jsonl");
		writeFileSync(sessionFile, "");
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const branch = [{ type: "message", id: "u1", parentId: null, message: { role: "user" } }];
		const ctx = {
			cwd,
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionId: () => "A",
				getBranch: () => branch,
				getEntries: () => branch,
			},
		};
		const pi = {
			appendEntry() {},
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		};
		registerCursorSessionResume(pi as never);
		registerCursorSessionLifecycle(pi as never);
		void handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		return { handlers, ctx, sessionFile };
	}

	test.each([
		["session_switch", "session_before_switch"],
		["session_branch", "session_before_branch"],
		["session_compact", "session_compact"],
	] as const)("%s after park rejects callbacks and next turn bootstraps", async (event, before) => {
		const { handlers, ctx } = hooks();
		const otherFile = join(cwd, "B.jsonl");
		writeFileSync(otherFile, "");
		const ctxB = {
			cwd,
			sessionManager: {
				getSessionFile: () => otherFile,
				getSessionId: () => "B",
				getBranch: () => [{ type: "message", id: "u1", parentId: null, message: { role: "user" } }],
				getEntries: () => [{ type: "message", id: "u1", parentId: null, message: { role: "user" } }],
			},
		};
		const ownerB = ownerForContext(ctxB as never);
		await withCursorSessionOwner(ownerB, () => runtime.prepareTurn({
			modelLimits: { contextWindow: 200_000, maxTokens: 8_192 },
			cwd,
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: { messages: [{ role: "user", content: "other", timestamp: 1 }] },
			grantedTools: [],
		}));
		const otherAgent = [...runtime.__testUtils.slots.values()].find((slot) => slot.owner === ownerB)?.agent?.agentId;
		expect(otherAgent).toBeDefined();

		const aEvents = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, PARK_CONTEXT));
		expect(expectOneTerminal(aEvents)).toMatchObject({ type: "done", reason: "toolUse" });
		const live = getLiveRun(runtime.runtimeKey());
		expect(live?.parked).toHaveLength(1);
		const rejected = Promise.withResolvers<void>();
		const callback = live!.parked[0]!;
		const previous = callback.reject.bind(callback);
		callback.reject = (error) => {
			previous(error);
			rejected.resolve();
		};
		for (const handler of handlers.get(before) ?? []) await handler({ type: before }, ctx);
		if (event !== before) {
			for (const handler of handlers.get(event) ?? []) {
				await handler({ type: event, reason: "new", compactionEntry: { type: "compaction", id: "c1", parentId: "u1" } }, ctx);
			}
		}
		await bounded(rejected.promise);
		expect(getMatchingResumeHandle("main", undefined, cwd)).toBeUndefined();
		expect([...runtime.__testUtils.slots.values()].find((slot) => slot.owner === ownerB)?.agent?.agentId).toBe(otherAgent);

		const next = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, {
			messages: [{ role: "user", content: "after switch", timestamp: 4 }],
		}));
		expectOneTerminal(next);
		expect(saved.at(-1)).toBeUndefined();
	});

	test("session_switch while send handle is pending rejects the live run", async () => {
		const { handlers, ctx } = hooks();
		const entered = deferred<void>();
		runtime.__testUtils.setOpenAgent(async () => {
			const agentId = `agent-${opens.length + 1}`;
			opens.push(agentId);
			return {
				agentId,
				async [Symbol.asyncDispose]() {},
				async send() {
					entered.resolve();
					return await new Promise<Run>(() => undefined);
				},
			} as unknown as SDKAgent;
		});
		const pending = collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest });
		await awaitEntered(entered.promise, pending);
		await handlers.get("session_before_switch")?.[0]?.({ type: "session_before_switch" }, ctx);
		await handlers.get("session_switch")?.[0]?.({ type: "session_switch", reason: "new" }, ctx);
		expectAborted(await bounded(pending));
	});

	const READ_TOKEN = "export const answer = 42";
	const DROPPED_PREFIX = "obsolete request about vanished.ts";

	function readParkContext(): Context {
		return {
			messages: [{ role: "user", content: "Read a.ts and report the token", timestamp: 1 }],
			tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } as Tool],
		};
	}

	async function compactParkedRead(handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>, ctx: unknown) {
		const parked = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, readParkContext()));
		const terminal = expectOneTerminal(parked);
		expect(terminal).toMatchObject({ type: "done", reason: "toolUse" });
		if (terminal.type !== "done") throw new Error("expected toolUse");
		const call = terminal.message.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("expected parked tool call");
		const live = getLiveRun(runtime.runtimeKey());
		expect(live?.parked).toHaveLength(1);
		const rejected = Promise.withResolvers<void>();
		let resumed = false;
		const callback = live!.parked[0]!;
		const previous = callback.reject.bind(callback);
		callback.reject = (error) => {
			previous(error);
			rejected.resolve();
		};
		callback.resolve = () => { resumed = true; };
		for (const handler of handlers.get("session_compact") ?? []) {
			await handler({
				type: "session_compact",
				reason: "new",
				compactionEntry: { type: "compaction", id: "c1", parentId: "u1" },
			}, ctx);
		}
		await bounded(rejected.promise);
		expect(getMatchingResumeHandle("main", undefined, cwd)).toBeUndefined();
		const summary = `Completed read of a.ts. Token: ${READ_TOKEN}. Dropped prefix: ${DROPPED_PREFIX}`;
		const effective: Context = {
			messages: [
				{ role: "compactionSummary", summary, tokensBefore: 64, timestamp: 0 } as Context["messages"][number],
				readParkContext().messages[0]!,
				terminal.message,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: READ_TOKEN }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "Recall the token without reading again", timestamp: 4 },
			],
			tools: readParkContext().tools,
		};
		return { effective, resumed: () => resumed };
	}

	test("compact after a completed read imports the summary and retained tail on a fresh agent without replay", async () => {
		const { handlers, ctx } = hooks();
		let executions = 0;
		const opens: Array<{ savedAgentId?: string; history?: Context["messages"]; prompt?: unknown }> = [];
		runtime.__testUtils.setOpenAgent(async (input) => {
			const record = { savedAgentId: input.savedAgentId, history: input.bootstrapHistory, prompt: undefined as unknown };
			opens.push(record);
			return {
				agentId: `agent-${opens.length}`,
				async [Symbol.asyncDispose]() {},
				async send(message: unknown, options?: SendOptions) {
					record.prompt = message;
					const tool = options?.local?.customTools?.read;
					if (opens.length === 1 && tool) {
						executions += 1;
						void tool.execute({ path: "a.ts" }, { toolCallId: "call-read" }).catch(() => undefined);
						return await new Promise<Run>(() => undefined);
					}
					return { supports: () => false, wait: async () => ({ status: "finished", result: "continued" }) } as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
		const { effective, resumed } = await compactParkedRead(handlers, ctx);
		const next = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, effective));
		const imported = effective.messages.slice(0, -1);
		expect(opens).toHaveLength(2);
		expect(opens[1]).toMatchObject({ savedAgentId: undefined, history: imported });
		expect(JSON.stringify(imported)).toContain(READ_TOKEN);
		expect(imported.some((message) => message.role === "user" && message.content === DROPPED_PREFIX)).toBe(false);
		expect(JSON.stringify(opens[1]?.prompt)).toContain("Recall the token without reading again");
		expect(JSON.stringify(opens[1]?.prompt)).not.toContain(READ_TOKEN);
		expect(JSON.stringify(opens[1]?.prompt)).not.toContain("Read a.ts and report the token");
		expect(next.some((event) => event.type === "toolcall_start")).toBe(false);
		expect(expectOneTerminal(next)).toMatchObject({ type: "done", reason: "stop", message: { content: [{ type: "text", text: "continued" }] } });
		expect(executions).toBe(1);
		expect(resumed()).toBe(false);
	});

	test("aborting the post-compact continuation does not resume or replay the completed read", async () => {
		const { handlers, ctx } = hooks();
		let executions = 0;
		const opens: Array<{ savedAgentId?: string; history?: Context["messages"]; prompt?: unknown }> = [];
		const entered = deferred<void>();
		const release = deferred<Run>();
		runtime.__testUtils.setOpenAgent(async (input) => {
			const record = { savedAgentId: input.savedAgentId, history: input.bootstrapHistory, prompt: undefined as unknown };
			opens.push(record);
			return {
				agentId: `agent-${opens.length}`,
				async [Symbol.asyncDispose]() {},
				async send(message: unknown, options?: SendOptions) {
					record.prompt = message;
					const tool = options?.local?.customTools?.read;
					if (opens.length === 1 && tool) {
						executions += 1;
						void tool.execute({ path: "a.ts" }, { toolCallId: "call-read" }).catch(() => undefined);
						return await new Promise<Run>(() => undefined);
					}
					if (opens.length === 2) {
						entered.resolve();
						return await release.promise;
					}
					return { supports: () => false, wait: async () => ({ status: "finished", result: "continued" }) } as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
		const { effective, resumed } = await compactParkedRead(handlers, ctx);
		const imported = effective.messages.slice(0, -1);
		const controller = new AbortController();
		const pending = collect({ apiKey: "test-key", cwd, signal: controller.signal, onPayload: scopeTestUtils.bindRequest }, effective);
		await awaitEntered(entered.promise, pending);
		controller.abort();
		expectAborted(await bounded(pending));
		expect(opens[1]).toMatchObject({ savedAgentId: undefined, history: imported });
		expect(JSON.stringify(opens[1]?.prompt)).not.toContain(READ_TOKEN);
		expect(executions).toBe(1);
		expect(resumed()).toBe(false);

		const followUp = collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, effective);
		release.resolve({ supports: () => false, wait: async () => ({ status: "cancelled", result: "stale compact" }) } as unknown as Run);
		const events = await bounded(followUp);
		expect(opens[2]).toMatchObject({ savedAgentId: undefined, history: imported });
		expect(expectOneTerminal(events)).toMatchObject({ type: "done", reason: "stop" });
		expect(JSON.stringify(events)).not.toContain("stale compact");
		expect(events.some((event) => event.type === "toolcall_start")).toBe(false);
		expect(executions).toBe(1);
		expect(resumed()).toBe(false);
	});
});

describe("provider grant fail-closed", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "omp-grant-"));
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		scopeTestUtils.set(cwd, join(cwd, "A.jsonl"), "A");
		resumeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setListModels(async () => ITEMS);
	});

	afterEach(() => {
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		resumeTestUtils.reset();
		scopeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		rmSync(cwd, { recursive: true, force: true });
	});

	test("parked continuation fails closed when the tool contract changes", async () => {
		runtime.__testUtils.setOpenAgent(async () => ({
			agentId: "agent-1",
			async [Symbol.asyncDispose]() {},
			async send(_message: unknown, options?: SendOptions) {
				const tools = options?.local?.customTools ?? {};
				void tools.a.execute({ path: "a.ts" }, { toolCallId: "call-a" }).catch(() => undefined);
				return {
					supports: () => false,
					wait: () => new Promise<RunResult>(() => undefined),
				} as unknown as Run;
			},
		} as unknown as SDKAgent));
		const parkContext: Context = {
			messages: [{ role: "user", content: "request A", timestamp: 1 }],
			tools: [TOOL_A, TOOL_B],
		};
		const parked = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, parkContext));
		const terminal = expectOneTerminal(parked);
		expect(terminal).toMatchObject({ type: "done", reason: "toolUse" });
		if (terminal.type !== "done") throw new Error("expected toolUse");
		const next = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, {
			messages: [parkContext.messages[0]!, terminal.message, toolResultMessage("call-a", "a")],
			tools: [TOOL_A],
		}));
		const failed = expectOneTerminal(next);
		expect(failed.type).toBe("error");
		if (failed.type !== "error") throw new Error("expected grant error");
		expect(failed.error.errorMessage).toMatch(/tool contract changed/);
	});
});

describe("provider cancel during baseline after tool-fingerprint rebuild", () => {
	let cwd: string;
	const READ = { name: "read", description: "read files", parameters: { type: "object", properties: { path: { type: "string" } } } } as Tool;
	const COMMITTED = "Already executed request";

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "omp-baseline-cancel-"));
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		// Ephemeral owner: no journal appendEntry; matches memory-only bridge consumption proofs.
		scopeTestUtils.set(cwd, undefined, "baseline-cancel");
		resumeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setListModels(async () => ITEMS);
	});

	afterEach(() => {
		runtime.__testUtils.clear();
		liveRunTestUtils.clear();
		resumeTestUtils.reset();
		scopeTestUtils.reset();
		catalogTestUtils.resetCatalog();
		rmSync(cwd, { recursive: true, force: true });
	});

	function sameContext(): Context {
		return {
			messages: [{ role: "user", content: COMMITTED, timestamp: 1 }],
			tools: [READ],
		};
	}

	function appendedContext(): Context {
		return {
			messages: [
				{ role: "user", content: COMMITTED, timestamp: 1 },
				{ role: "user", content: "New request", timestamp: 2 },
			],
			tools: [READ],
		};
	}

	function installAgent(options: {
		blockBaseline?: () => boolean;
		onBaselineEntered?: () => void;
		releaseBaseline?: Promise<void>;
		failSend?: () => boolean;
		prompts: unknown[];
		opens: Array<{ savedAgentId?: string; history?: Context["messages"] }>;
	}) {
		runtime.__testUtils.setOpenAgent(async (input) => {
			const record = { savedAgentId: input.savedAgentId, history: input.bootstrapHistory };
			options.opens.push(record);
			const originalGet = input.store.agents.get.bind(input.store.agents);
			input.store.agents.get = async (query) => {
				if (options.blockBaseline?.()) {
					options.onBaselineEntered?.();
					await options.releaseBaseline;
				}
				return originalGet(query);
			};
			return {
				agentId: `agent-${options.opens.length}`,
				async [Symbol.asyncDispose]() {},
				async send(message: unknown) {
					options.prompts.push(message);
					if (options.failSend?.()) throw new Error("send boom");
					return {
						supports: () => false,
						wait: async () => ({ status: "finished", result: "ok" }),
					} as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
	}

	async function commitFirstTurn(opens: Array<{ savedAgentId?: string; history?: Context["messages"] }>, prompts: unknown[]) {
		installAgent({ opens, prompts });
		const events = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, sameContext()));
		expect(expectOneTerminal(events)).toMatchObject({ type: "done", reason: "stop" });
		expect(prompts).toHaveLength(1);
		const slot = [...runtime.__testUtils.slots.values()][0];
		expect(slot?.bindingState).toBe("committed");
		expect(slot?.sendState.bootstrapped).toBe(true);
		slot!.toolContractFingerprint = "omp-custom-tools-v1-stale";
		return slot!;
	}

	test("abort during baseline after fingerprint rebuild does not call send and keeps consumption", async () => {
		const opens: Array<{ savedAgentId?: string; history?: Context["messages"] }> = [];
		const prompts: unknown[] = [];
		await commitFirstTurn(opens, prompts);

		const baselineEntered = deferred<void>();
		const releaseBaseline = deferred<void>();
		let blockBaseline = true;
		installAgent({
			opens,
			prompts,
			blockBaseline: () => blockBaseline,
			onBaselineEntered: () => baselineEntered.resolve(),
			releaseBaseline: releaseBaseline.promise,
		});

		const controller = new AbortController();
		const pending = collect(
			{ apiKey: "test-key", cwd, signal: controller.signal, onPayload: scopeTestUtils.bindRequest },
			sameContext(),
		);
		await awaitEntered(baselineEntered.promise, pending);
		expect(prompts).toHaveLength(1);
		controller.abort();
		releaseBaseline.resolve();
		expectAborted(await bounded(pending));
		expect(prompts).toHaveLength(1);

		const slot = [...runtime.__testUtils.slots.values()][0];
		expect(slot?.preSendConsumption?.sendState.bootstrapped).toBe(true);
		expect(slot?.sendState.bootstrapped).toBe(true);
		expect(slot?.agent).toBeUndefined();

		blockBaseline = false;
		opens.length = 0;
		const retry = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, sameContext()));
		expect(expectOneTerminal(retry)).toMatchObject({ type: "done", reason: "stop" });
		expect(prompts).toHaveLength(2);
		expect(opens).toEqual([{ savedAgentId: undefined, history: sameContext().messages }]);
		expect(JSON.stringify(prompts[1])).toContain("Continue the conversation from where it left off.");
		expect(JSON.stringify(prompts[1])).not.toContain(COMMITTED);
	});

	test("abort during baseline then append sends only the new input", async () => {
		const opens: Array<{ savedAgentId?: string; history?: Context["messages"] }> = [];
		const prompts: unknown[] = [];
		await commitFirstTurn(opens, prompts);

		const baselineEntered = deferred<void>();
		const releaseBaseline = deferred<void>();
		installAgent({
			opens,
			prompts,
			blockBaseline: () => true,
			onBaselineEntered: () => baselineEntered.resolve(),
			releaseBaseline: releaseBaseline.promise,
		});
		const controller = new AbortController();
		const pending = collect(
			{ apiKey: "test-key", cwd, signal: controller.signal, onPayload: scopeTestUtils.bindRequest },
			sameContext(),
		);
		await awaitEntered(baselineEntered.promise, pending);
		controller.abort();
		releaseBaseline.resolve();
		expectAborted(await bounded(pending));
		expect(prompts).toHaveLength(1);

		installAgent({ opens, prompts });
		opens.length = 0;
		const next = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, appendedContext()));
		expect(expectOneTerminal(next)).toMatchObject({ type: "done", reason: "stop" });
		expect(prompts).toHaveLength(2);
		expect(opens).toEqual([{ savedAgentId: undefined, history: sameContext().messages }]);
		expect(JSON.stringify(prompts[1])).toContain("New request");
		expect(JSON.stringify(prompts[1])).not.toContain(COMMITTED);
	});

	test("failure after agent.send starts dirties and retries without pre-send consumption", async () => {
		const opens: Array<{ savedAgentId?: string; history?: Context["messages"] }> = [];
		const prompts: unknown[] = [];
		await commitFirstTurn(opens, prompts);

		let failSend = true;
		installAgent({
			opens,
			prompts,
			failSend: () => failSend,
		});
		const failed = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, sameContext()));
		expect(expectOneTerminal(failed)).toMatchObject({ type: "error" });
		expect(prompts).toHaveLength(2);
		const slot = [...runtime.__testUtils.slots.values()][0];
		expect(slot?.preSendConsumption).toBeUndefined();
		expect(slot?.sendState.bootstrapped).toBe(false);

		failSend = false;
		opens.length = 0;
		const retry = await bounded(collect({ apiKey: "test-key", cwd, onPayload: scopeTestUtils.bindRequest }, sameContext()));
		expect(expectOneTerminal(retry)).toMatchObject({ type: "done", reason: "stop" });
		expect(prompts).toHaveLength(3);
		expect(opens).toEqual([{ savedAgentId: undefined, history: [] }]);
		expect(JSON.stringify(prompts[2])).toContain(COMMITTED);
		expect(JSON.stringify(prompts[2])).not.toContain("Continue the conversation from where it left off.");
	});
});


