import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelListItem, Run, RunResult, SDKAgent, SDKCustomToolResult, SDKUserMessage, SendOptions } from "@cursor/sdk";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";
import { ensureCursorModels, __testUtils as catalogTestUtils } from "../../src/catalog.ts";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID, CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE } from "../../src/constants.ts";
import { HOST_BRIDGE_OPTION_KEY } from "../../src/host-option.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as controlsTestUtils } from "../../src/model-controls.ts";
import { streamCursorRuntime } from "../../src/provider.ts";
import { registerCursorSessionLifecycle } from "../../src/session-lifecycle.ts";
import { parseResumeEntryData, registerCursorSessionResume, __testUtils as resumeTestUtils, type ResumeSessionEntry } from "../../src/session-resume.ts";
import { disposeRuntimeForScope, __testUtils as runtimeTestUtils } from "../../src/session-runtime.ts";
import { registerCursorSessionScope, __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
import { createFakeHost } from "../helpers/fake-host.ts";

const ITEMS: ModelListItem[] = [{ id: "composer-2.5", displayName: "Composer 2.5" }];
const MODEL = { id: "composer-2.5", provider: CURSOR_SDK_PROVIDER_ID, api: CURSOR_SDK_API, contextWindow: 200_000, maxTokens: 8_192 } as Model<Api>;
const READ = { name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } as Tool;

function userContext(text: string, tools: Tool[] = []): Context {
	return { messages: [{ role: "user", content: text, timestamp: 1 }], tools };
}

async function collect(context: Context, options: SimpleStreamOptions): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamCursorRuntime(MODEL, context, options)) events.push(event);
	return events;
}

function expectAnswer(events: AssistantMessageEvent[], text: string): void {
	expect(events.filter((event) => event.type === "error" || event.type === "done")).toMatchObject([
		{ type: "done", reason: "stop", message: { content: [{ type: "text", text }] } },
	]);
}

function continuation(initial: Context, events: AssistantMessageEvent[]): Context {
	const done = events.at(-1);
	expect(done).toMatchObject({ type: "done", reason: "toolUse", message: { content: [
		{ type: "toolCall", id: "parent-read", name: "read", arguments: { path: "parent.ts" } },
	] } });
	if (done?.type !== "done") throw new Error("Parent did not yield its tool call");
	return {
		...initial,
		messages: [...initial.messages, done.message, {
			role: "toolResult", toolCallId: "parent-read", toolName: "read",
			content: [{ type: "text", text: "parent file contents" }], isError: false, timestamp: 3,
		}],
	};
}

interface SessionFixture {
	file: string;
	emit(type: string, payload?: unknown): Promise<void>;
	options: SimpleStreamOptions;
}

describe("provider session isolation through host hooks", () => {
	let cwd: string;
	let sessions: SessionFixture[];
	let sends: Array<{ agentId: string; message: unknown }>;
	let cancellations: string[];
	let disposals: string[];
	let toolCalls: number;
	let toolResults: SDKCustomToolResult[];
	let releases: Array<() => void>;

	beforeEach(async () => {
		cwd = mkdtempSync(join(tmpdir(), "omp-provider-isolation-"));
		sessions = [];
		sends = [];
		cancellations = [];
		disposals = [];
		toolCalls = 0;
		toolResults = [];
		releases = [];
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		controlsTestUtils.reset();
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setListModels(async () => ITEMS);
		catalogTestUtils.registerModelItems(ITEMS);
		await ensureCursorModels("test-key");
	});

	afterEach(async () => {
		for (const release of releases) release();
		for (const host of sessions) await host.emit("session_shutdown");
		for (const scopeKey of new Set([...runtimeTestUtils.slots.values()].map((slot) => slot.scopeKey))) {
			await disposeRuntimeForScope(scopeKey);
		}
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		resumeTestUtils.reset();
		scopeTestUtils.reset();
		controlsTestUtils.reset();
		catalogTestUtils.resetCatalog();
		rmSync(cwd, { recursive: true, force: true });
	});

	async function session(id: string): Promise<SessionFixture> {
		const file = join(cwd, `${id}.jsonl`);
		const timestamp = "2026-09-11T00:00:00.000Z";
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })}\n`);
		const branch: ResumeSessionEntry[] = [];
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const ctx = { cwd, sessionManager: {
			getSessionId: () => id, getSessionFile: () => file,
			getBranch: () => branch, getEntries: () => branch,
		} };
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			appendEntry(customType: string, data?: unknown) {
				const entry = { type: "custom", id: `${id}-${branch.length + 1}`, parentId: branch.at(-1)?.id ?? null, timestamp, customType, data };
				branch.push(entry);
				appendFileSync(file, `${JSON.stringify(entry)}\n`);
			},
		};
		registerCursorSessionResume(pi as never);
		registerCursorSessionLifecycle(pi as never);
		registerCursorSessionScope(pi as never);
		async function emit(type: string, payload?: unknown) {
			for (const handler of handlers.get(type) ?? []) await handler({ type, model: MODEL, payload }, ctx);
		}
		const options: SimpleStreamOptions = {
			apiKey: "test-key", cwd, sessionId: id,
			onPayload: async (payload) => { await emit("before_provider_request", payload); },
		};
		const host = { file, emit, options };
		sessions.push(host);
		await emit("session_start");
		return host;
	}

	function resumeRecords(file: string) {
		return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
			.filter((entry) => entry.customType === CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE)
			.map((entry) => {
				const data = parseResumeEntryData(entry.data);
				expect(data).toBeDefined();
				return data!;
			});
	}

	function installAgents() {
		let opened = 0;
		runtimeTestUtils.setOpenAgent(async () => {
			const agentId = `agent-${++opened}`;
			return {
				agentId,
				close() { disposals.push(agentId); },
				async [Symbol.asyncDispose]() { disposals.push(agentId); },
				async send(message: SDKUserMessage, options?: SendOptions) {
					sends.push({ agentId, message });
					const tool = options?.local?.customTools?.read;
					let result: Promise<SDKCustomToolResult> | undefined;
					if (tool) {
						toolCalls++;
						result = tool.execute({ path: "parent.ts" }, { toolCallId: "parent-read" });
					}
					return {
						supports: (capability: string) => capability === "cancel",
						async cancel() { cancellations.push(agentId); },
						async wait(): Promise<RunResult> {
							if (result) {
								const value = await result;
								toolResults.push(value);
								return { status: "finished", result: JSON.stringify(value) } as RunResult;
							}
							return { status: "finished", result: message.text } as RunResult;
						},
					} as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
		return () => opened;
	}

	test("new bridge objects retain snapshot identity and only the latest bridge signal can cancel the reused agent", async () => {
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<RunResult>();
		const disposed = Promise.withResolvers<void>();
		releases.push(() => finish.resolve({ status: "finished" } as RunResult));
		let opened = 0;
		runtimeTestUtils.setOpenAgent(async () => {
			const agentId = `agent-${++opened}`;
			return {
				agentId,
				async [Symbol.asyncDispose]() { disposals.push(agentId); disposed.resolve(); },
				async send(message: SDKUserMessage) {
					sends.push({ agentId, message });
					const second = sends.length === 2;
					if (second) entered.resolve();
					return {
						supports: (capability: string) => capability === "cancel",
						async cancel() { cancellations.push(agentId); },
						wait: () => second ? finish.promise : Promise.resolve({ status: "finished", result: "first answer" }),
					} as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
		const oldSignal = new AbortController();
		const currentSignal = new AbortController();
		const firstBridge = createFakeHost({ cwd, sessionId: "bridged", tools: [] });
		const secondBridge = createFakeHost({ cwd, sessionId: "bridged", tools: [] });
		firstBridge.signal = oldSignal.signal;
		secondBridge.signal = currentSignal.signal;
		const initial = userContext("first input");
		const first = await collect(initial, { apiKey: "test-key", [HOST_BRIDGE_OPTION_KEY]: firstBridge } as SimpleStreamOptions);
		expectAnswer(first, "first answer");
		const done = first.at(-1);
		if (done?.type !== "done") throw new Error("First bridged request did not finish");
		const context: Context = { messages: [
			...initial.messages, done.message, { role: "user", content: "second input", timestamp: 3 },
		] };
		const second = collect(context, { apiKey: "test-key", [HOST_BRIDGE_OPTION_KEY]: secondBridge } as SimpleStreamOptions);
		await Promise.race([entered.promise, second.then(() => { throw new Error("Second bridged request never entered send"); })]);
		expect(opened).toBe(1);
		expect(sends).toEqual([
			{ agentId: "agent-1", message: { text: "first input" } },
			{ agentId: "agent-1", message: { text: "second input" } },
		]);
		const cancellationsBefore = [...cancellations];
		oldSignal.abort();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(cancellations).toEqual(cancellationsBefore);
		expect(disposals).toEqual([]);
		currentSignal.abort();
		expect((await second).filter((event) => event.type === "error" || event.type === "done")).toMatchObject([
			{ type: "error", reason: "aborted", error: { stopReason: "aborted" } },
		]);
		await disposed.promise;
		expect(cancellations.length).toBeGreaterThan(cancellationsBefore.length);
		expect(disposals).toEqual(["agent-1"]);
		expect(firstBridge.bindings).toMatchObject([{ sdkAgentId: "agent-1", state: "committed" }]);
		expect(secondBridge.bindings).toEqual([]);
	});

	test("branching while onPayload is pending aborts the old request before opening an agent but allows a fresh request", async () => {
		const opened = installAgents();
		const parent = await session("parent");
		const beforeRequest = readFileSync(parent.file, "utf8");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.push(() => release.resolve());
		const originalHook = parent.options.onPayload!;
		let first = true;
		parent.options.onPayload = async (payload, model) => {
			await originalHook(payload, model);
			if (first) {
				first = false;
				entered.resolve();
				await release.promise;
			}
			return payload;
		};
		const oldRequest = collect(userContext("obsolete pre-branch input"), parent.options);
		await Promise.race([entered.promise, oldRequest.then(() => { throw new Error("Request never entered onPayload"); })]);
		await parent.emit("session_before_branch");
		release.resolve();
		const events = await oldRequest;
		expect(events.filter((event) => event.type === "error" || event.type === "done")).toMatchObject([
			{ type: "error", reason: "aborted", error: { stopReason: "aborted" } },
		]);
		expect(opened()).toBe(0);
		expect(sends).toEqual([]);
		expect(readFileSync(parent.file, "utf8")).toBe(beforeRequest);
		expectAnswer(await collect(userContext("fresh branch answer"), parent.options), "fresh branch answer");
		await parent.emit("turn_end");
		expect(opened()).toBe(1);
		expect(resumeRecords(parent.file)).toEqual([expect.objectContaining({
			state: "committed", agentId: "agent-1", sessionId: "parent", sessionFile: parent.file,
		})]);
	});

	test("child registration, completion and shutdown preserve the parent's original payload hook and parked SDK callback", async () => {
		installAgents();
		const parent = await session("parent");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.push(() => release.resolve());
		const originalHook = parent.options.onPayload!;
		const replacement = userContext("replacement parent input", [READ]);
		let payloadCalls = 0;
		parent.options.onPayload = async (payload, model) => {
			await originalHook(payload, model);
			if (++payloadCalls !== 1) return payload;
			entered.resolve();
			await release.promise;
			return replacement;
		};
		const parentStream = collect(userContext("discard this original input"), parent.options);
		await Promise.race([entered.promise, parentStream.then(() => { throw new Error("Parent never entered onPayload"); })]);
		const child = await session("child");
		release.resolve();
		const parked = await parentStream;
		const next = continuation(replacement, parked);
		expect(sends).toEqual([{ agentId: "agent-1", message: { text: "replacement parent input" } }]);
		expectAnswer(await collect(userContext("child answer"), child.options), "child answer");
		await child.emit("turn_end");
		await child.emit("session_shutdown");
		expect(cancellations).not.toContain("agent-1");
		expect(disposals).not.toContain("agent-1");
		expect(disposals).toContain("agent-2");
		expect(toolResults).toEqual([]);
		expectAnswer(await collect(next, parent.options), JSON.stringify({ content: [{ type: "text", text: "parent file contents" }], isError: false }));
		await parent.emit("turn_end");
		expect(payloadCalls).toBe(2);
		expect(toolCalls).toBe(1);
		expect(toolResults).toEqual([{ content: [{ type: "text", text: "parent file contents" }], isError: false }]);
		expect(sends.map((send) => send.agentId)).toEqual(["agent-1", "agent-2"]);
		expect(resumeRecords(parent.file)).toEqual([expect.objectContaining({ state: "committed", agentId: "agent-1", sessionId: "parent", sessionFile: parent.file })]);
		expect(resumeRecords(child.file)).toEqual([expect.objectContaining({ state: "committed", agentId: "agent-2", sessionId: "child", sessionFile: child.file })]);
	});

	test("a no-hook title with the parent's routing sessionId is disposable and cannot consume its parked run or resume writer", async () => {
		installAgents();
		const parent = await session("parent");
		const initial = userContext("parent input", [READ]);
		const next = continuation(initial, await collect(initial, parent.options));
		const beforeTitle = readFileSync(parent.file, "utf8");
		expectAnswer(await collect(userContext("title answer"), { apiKey: "test-key", cwd, sessionId: "parent" }), "title answer");
		// Provider terminal events can precede asynchronous agent disposal.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await parent.emit("turn_end");
		expect(readFileSync(parent.file, "utf8")).toBe(beforeTitle);
		expect(disposals).toEqual(["agent-2"]);
		expect(cancellations).not.toContain("agent-1");
		expect(toolResults).toEqual([]);
		expectAnswer(await collect(next, parent.options), JSON.stringify({ content: [{ type: "text", text: "parent file contents" }], isError: false }));
		await parent.emit("turn_end");
		expect(toolCalls).toBe(1);
		expect(toolResults).toEqual([{ content: [{ type: "text", text: "parent file contents" }], isError: false }]);
		expect(sends.map((send) => send.agentId)).toEqual(["agent-1", "agent-2"]);
		expect(resumeRecords(parent.file)).toEqual([expect.objectContaining({ state: "committed", agentId: "agent-1", sessionId: "parent", sessionFile: parent.file })]);
	});
});
