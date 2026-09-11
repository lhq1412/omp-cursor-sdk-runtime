import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { __testUtils, CursorSearchNotPerformedError, isWebSearchToolName, runCursorWebSearch } from "../../src/cursor-web-search.ts";
import { JsonlLocalAgentStore, type AgentOptions, type RunResult, type SDKAgent, type SDKMessage } from "@cursor/sdk";

const params = { query: "current SDK release", apiKey: "test-key", cwd: "/tmp" };

function searchCall(status: "running" | "completed" | "error", name = "webSearch", call_id = "search-1"): SDKMessage {
	return { type: "tool_call", agent_id: "agent", run_id: "run", call_id, name, status } as SDKMessage;
}

function setup(events: SDKMessage[] = [searchCall("completed")], result: Partial<RunResult> = {}) {
	let options: AgentOptions;
	let prompt: unknown;
	let disposed = false;
	let cancellations = 0;
	let root = "";
	const sendGate = Promise.withResolvers<void>();
	const streamGate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const streamStarted = Promise.withResolvers<void>();
	const disposeGate = Promise.withResolvers<void>();
	const cancelGate = Promise.withResolvers<void>();
	const disposedAt = Promise.withResolvers<void>();
	const cancelledAt = Promise.withResolvers<void>();
	const fixture = {
		holdSend: false,
		holdStream: false,
		cancelFails: false,
		holdDispose: false,
		holdCancel: false,
		exitOnDispose: false,
		exitOnCancel: false,
		streamAbort: false,
		beforeStream: () => {},
		beforeSend: () => {},
		started: started.promise,
		streamStarted: streamStarted.promise,
		whenDisposed: disposedAt.promise,
		whenCancelled: cancelledAt.promise,
		releaseSend() { sendGate.resolve(); },
		releaseStream() { streamGate.resolve(); },
		releaseDispose() { disposeGate.resolve(); },
		releaseCancel() { cancelGate.resolve(); },
		get options() { return options; },
		get prompt() { return prompt; },
		get disposed() { return disposed; },
		get cancellations() { return cancellations; },
		get root() { return root; },
	};
	__testUtils.setCreateAgent(async (input) => {
		options = input;
		root = Reflect.get(input.local!.store!, "rootDir");
		expect(existsSync(root)).toBe(true);
		return {
			async send(message) {
				prompt = message;
				fixture.beforeSend();
				started.resolve();
				if (fixture.holdSend) await sendGate.promise;
				return {
					async *stream() {
						fixture.beforeStream();
						streamStarted.resolve();
						if (fixture.holdStream) await streamGate.promise;
						if (fixture.streamAbort) throw new DOMException("SDK stream aborted", "AbortError");
						for (const event of events) yield event;
					},
					async wait() { return { id: "run-search", status: "finished", result: "Answer: https://example.com/news", ...result }; },
					async cancel() {
						cancellations++;
						if (fixture.holdCancel) await cancelGate.promise;
						if (!fixture.cancelFails) streamGate.resolve();
						if (fixture.exitOnCancel) process.exit(1);
						cancelledAt.resolve();
					},
				};
			},
			async [Symbol.asyncDispose]() {
				if (fixture.holdDispose) await disposeGate.promise;
				disposed = true;
				if (fixture.exitOnDispose) process.exit(1);
				disposedAt.resolve();
			},
		} as SDKAgent;
	});
	return fixture;
}

afterEach(() => __testUtils.reset());

describe("runCursorWebSearch", () => {
	test("searches with only the native webSearch tool and returns deduped sources", async () => {
		const fixture = setup(undefined, { result: "See [news](https://example.com/news), https://example.com/news and https://example.org/update." });
		const answer = await runCursorWebSearch({ ...params, recency: "week", limit: 3, num_search_results: 5 });
		expect(fixture.options.tools).toEqual(["webSearch"]);
		expect(fixture.options.mcpServers).toEqual({});
		expect(fixture.options.local?.customTools).toEqual({});
		expect(fixture.options.local?.settingSources).toEqual([]);
		expect(fixture.options.local?.enableAgentRetries).toBe(false);
		expect("systemPrompt" in fixture.options).toBe(false);
		expect(fixture.options.local?.store).toBeInstanceOf(JsonlLocalAgentStore);
		expect(fixture.prompt).toContain("webSearch");
		expect(fixture.prompt).toContain(params.query);
		expect(fixture.prompt).toContain("source URLs");
		expect(fixture.prompt).toContain("recency: week");
		expect(fixture.prompt).toContain("limit: 3");
		expect(fixture.prompt).toContain("num_search_results: 5");
		expect(answer.content).toEqual([{ type: "text", text: "See [news](https://example.com/news), https://example.com/news and https://example.org/update.\n\n## Sources\n- https://example.com/news\n- https://example.org/update" }]);
		expect(fixture.disposed).toBe(true);
		expect(existsSync(fixture.root)).toBe(false);
	});

	test.each(["webSearch", "web_search", "web_search_tool_call", "WEB-SEARCH-TOOL-CALL"])("accepts a completed %s tool call without duplicating existing sources", async (name) => {
		setup([searchCall("completed", name)], { result: "Answer\n\n## Sources\n- https://example.com" });
		expect(await runCursorWebSearch(params)).toEqual({ content: [{ type: "text", text: "Answer\n\n## Sources\n- https://example.com" }] });
	});

	test("does not accept a running or failed webSearch as proof of search", async () => {
		setup([searchCall("running"), searchCall("error")]);
		await expect(runCursorWebSearch(params)).rejects.toBeInstanceOf(CursorSearchNotPerformedError);
	});

	test("does not accept prose or other tools as proof of search", async () => {
		const fixture = setup([{ type: "text", text: "webSearch" } as SDKMessage, searchCall("completed", "webFetch")]);
		await expect(runCursorWebSearch(params)).rejects.toBeInstanceOf(CursorSearchNotPerformedError);
		expect(fixture.disposed).toBe(true);
		expect(existsSync(fixture.root)).toBe(false);
		expect(isWebSearchToolName(undefined)).toBe(false);
	});

	test("preserves SDK errors instead of reporting search not performed", async () => {
		setup([], { status: "error", error: { message: "Search backend unavailable" } });
		await expect(runCursorWebSearch(params)).rejects.toThrow("Search backend unavailable");
	});

	test("rejects empty searched answers", async () => {
		setup(undefined, { result: " \n " });
		await expect(runCursorWebSearch(params)).rejects.toThrow("empty answer");
	});

	test("reports SDK cancellation without a user abort as a search failure", async () => {
		setup([], { status: "cancelled" });
		await expect(runCursorWebSearch(params)).rejects.toThrow("Cursor web search failed");
	});

	test("aborts before create even with a non-Error signal reason", async () => {
		let created = false;
		__testUtils.setCreateAgent(async () => { created = true; throw new Error("unexpected create"); });
		await expect(runCursorWebSearch({ ...params, signal: AbortSignal.abort("stop") })).rejects.toMatchObject({ name: "AbortError" });
		expect(created).toBe(false);
	});

	test("aborts a hanging send without waiting for it to return", async () => {
		const fixture = setup();
		fixture.holdSend = true;
		const controller = new AbortController();
		const pending = runCursorWebSearch({ ...params, signal: controller.signal });
		await fixture.started;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(fixture.cancellations).toBe(0);
		fixture.releaseSend();
		await Promise.resolve();
		expect(fixture.disposed).toBe(true);
	});

	test("times out a hanging send as a search failure, not AbortError", async () => {
		const fixture = setup();
		fixture.holdSend = true;
		const pending = runCursorWebSearch({ ...params, timeoutMs: 20 });
		await expect(pending).rejects.toThrow("timed out");
		expect(fixture.cancellations).toBe(0);
		fixture.releaseSend();
	});

	test("removes its abort listener after a completed search", async () => {
		const fixture = setup();
		const controller = new AbortController();
		await runCursorWebSearch({ ...params, signal: controller.signal });
		controller.abort();
		expect(fixture.cancellations).toBe(0);
	});

	test.each(["beforeSend", "beforeStream"] as const)("cancels and disposes when aborted during %s", async (phase) => {
		const fixture = setup([]);
		const controller = new AbortController();
		fixture[phase] = () => controller.abort(new Error("stop"));
		await expect(runCursorWebSearch({ ...params, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		expect(fixture.disposed).toBe(true);
		expect(existsSync(fixture.root)).toBe(false);
	});

	test("times out a hanging stream even if cancel does not end it", async () => {
		const fixture = setup();
		fixture.holdStream = true;
		fixture.cancelFails = true;
		await expect(runCursorWebSearch({ ...params, timeoutMs: 30 })).rejects.toThrow("timed out");
		expect(fixture.cancellations).toBe(1);
	});

	test("aborts a hanging stream without waiting for the iterator", async () => {
		const fixture = setup();
		fixture.holdStream = true;
		fixture.cancelFails = true;
		const controller = new AbortController();
		const pending = runCursorWebSearch({ ...params, signal: controller.signal });
		await fixture.streamStarted;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	test("SDK AbortError after timeout is a search failure, not user cancel", async () => {
		const fixture = setup();
		fixture.holdStream = true;
		fixture.streamAbort = true;
		await expect(runCursorWebSearch({ ...params, timeoutMs: 30 })).rejects.toThrow("timed out");
		expect(fixture.cancellations).toBe(1);
	});

	test("hanging dispose does not prevent timeout from returning", async () => {
		const fixture = setup();
		fixture.holdStream = true;
		fixture.cancelFails = true;
		fixture.holdDispose = true;
		await expect(runCursorWebSearch({ ...params, timeoutMs: 30 })).rejects.toThrow("timed out");
		fixture.releaseDispose();
		await fixture.whenDisposed;
	});

	test("late dispose still swallows process.exit after the search returns", async () => {
		const fixture = setup();
		fixture.holdDispose = true;
		fixture.exitOnDispose = true;
		const original = process.exit;
		const seen: number[] = [];
		process.exit = ((code?: number) => {
			seen.push(code ?? -1);
			return undefined as never;
		}) as typeof process.exit;
		try {
			await runCursorWebSearch(params);
			expect(seen).toEqual([]);
			fixture.releaseDispose();
			await fixture.whenDisposed;
			expect(seen).toEqual([]);
			expect(fixture.disposed).toBe(true);
		} finally {
			process.exit = original;
		}
	});

	test("late cancel still swallows process.exit after timeout returns", async () => {
		const fixture = setup();
		fixture.holdStream = true;
		fixture.holdCancel = true;
		fixture.exitOnCancel = true;
		const original = process.exit;
		const seen: number[] = [];
		process.exit = ((code?: number) => {
			seen.push(code ?? -1);
			return undefined as never;
		}) as typeof process.exit;
		try {
			await expect(runCursorWebSearch({ ...params, timeoutMs: 30 })).rejects.toThrow("timed out");
			expect(fixture.cancellations).toBe(1);
			expect(seen).toEqual([]);
			fixture.releaseCancel();
			await fixture.whenCancelled;
			expect(seen).toEqual([]);
		} finally {
			process.exit = original;
		}
	});
});
