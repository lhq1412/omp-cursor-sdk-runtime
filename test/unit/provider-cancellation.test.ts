import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelListItem, Run, RunResult, SDKAgent, SendOptions } from "@cursor/sdk";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { HOST_BRIDGE_OPTION_KEY } from "../../src/host-option.ts";
import { streamCursorRuntime } from "../../src/provider.ts";
import { ensureCursorModels, __testUtils as catalogTestUtils } from "../../src/catalog.ts";
import * as runtime from "../../src/session-runtime.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
import { getMatchingResumeHandle, registerCursorSessionResume, __testUtils as resumeTestUtils } from "../../src/session-resume.ts";
import { createFakeHost } from "../helpers/fake-host.ts";

const ITEMS: ModelListItem[] = [{ id: "composer-2.5", displayName: "Composer 2.5" }];
const MODEL = { id: "composer-2.5", provider: CURSOR_SDK_PROVIDER_ID, api: CURSOR_SDK_API, contextWindow: 200_000, maxTokens: 8_192 } as Model<Api>;
const CONTEXT: Context = { messages: [{ role: "user", content: "request A", timestamp: 1 }] };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function collect(options: SimpleStreamOptions, context = CONTEXT) {
	return (async () => {
		const events: AssistantMessageEvent[] = [];
		for await (const event of streamCursorRuntime(MODEL, context, options)) events.push(event);
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
