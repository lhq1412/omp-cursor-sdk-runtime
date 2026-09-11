import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { __testUtils, CursorSearchNotPerformedError, isWebSearchToolName, runCursorWebSearch } from "../../src/cursor-web-search.ts";
import { JsonlLocalAgentStore, type AgentOptions, type RunResult, type SDKAgent, type SDKMessage } from "@cursor/sdk";

const params = { query: "current SDK release", apiKey: "test-key", cwd: "/tmp" };

function setup(events: Array<{ type: string; name?: string }> = [{ type: "tool_call", name: "webSearch" }], result: Partial<RunResult> = {}) {
	let options: AgentOptions;
	let prompt: unknown;
	let disposed = false;
	let cancellations = 0;
	let root = "";
	const fixture = {
		beforeStream: () => {},
		beforeSend: () => {},
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
				return {
					async *stream() {
						fixture.beforeStream();
						for (const event of events) yield event as SDKMessage;
					},
					async wait() { return { id: "run-search", status: "finished", result: "Answer: https://example.com/news", ...result }; },
					async cancel() { cancellations++; },
				};
			},
			async [Symbol.asyncDispose]() { disposed = true; },
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

	test.each(["webSearch", "web_search", "web_search_tool_call", "WEB-SEARCH-TOOL-CALL"])("accepts a %s tool call without duplicating existing sources", async (name) => {
		setup([{ type: "tool_call", name }], { result: "Answer\n\n## Sources\n- https://example.com" });
		expect(await runCursorWebSearch(params)).toEqual({ content: [{ type: "text", text: "Answer\n\n## Sources\n- https://example.com" }] });
	});

	test("does not accept prose or other tools as proof of search", async () => {
		const fixture = setup([{ type: "text", name: "webSearch" }, { type: "tool_call", name: "webFetch" }]);
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

	test("reports SDK cancellation as AbortError before checking search", async () => {
		setup([], { status: "cancelled" });
		await expect(runCursorWebSearch(params)).rejects.toMatchObject({ name: "AbortError" });
	});

	test("aborts before create even with a non-Error signal reason", async () => {
		let created = false;
		__testUtils.setCreateAgent(async () => { created = true; throw new Error("unexpected create"); });
		await expect(runCursorWebSearch({ ...params, signal: AbortSignal.abort("stop") })).rejects.toMatchObject({ name: "AbortError" });
		expect(created).toBe(false);
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
		expect(fixture.cancellations).toBe(1);
		expect(fixture.disposed).toBe(true);
		expect(existsSync(fixture.root)).toBe(false);
	});
});
