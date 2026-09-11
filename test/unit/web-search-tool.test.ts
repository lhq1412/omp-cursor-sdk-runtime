import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SDKAgent } from "@cursor/sdk";
import { CURSOR_API_KEY_ENV_VAR, CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { __testUtils, CursorSearchNotPerformedError } from "../../src/cursor-web-search.ts";
import { executeCursorWebSearchTool } from "../../src/web-search-tool.ts";

const nativeResult = { content: [{ type: "text" as const, text: "Native answer" }], details: { native: true } };
const params = { query: "current Bun release", recency: "week", limit: 3 };
const originalKey = process.env[CURSOR_API_KEY_ENV_VAR];

beforeEach(() => {
	delete process.env[CURSOR_API_KEY_ENV_VAR];
});

afterEach(() => {
	__testUtils.reset();
	if (originalKey === undefined) delete process.env[CURSOR_API_KEY_ENV_VAR];
	else process.env[CURSOR_API_KEY_ENV_VAR] = originalKey;
});

function context(key?: string) {
	return {
		cwd: "/tmp",
		model: { provider: "other" },
		modelRegistry: { authStorage: { getApiKey: mock(async () => key) } },
		invokeTool: mock(async () => nativeResult),
	};
}

function sidecar(performed = true) {
	const create = mock(async () => ({
		send: async () => ({
			async *stream() {
				if (performed) yield { type: "tool_call", name: "webSearch", call_id: "search-1", status: "completed" };
			},
			wait: async () => ({ status: "completed", result: "Cursor answer" }),
			cancel: async () => {},
		}),
		async [Symbol.asyncDispose]() {},
	}) as unknown as SDKAgent);
	__testUtils.setCreateAgent(create);
	return create;
}

describe("web_search shadow routing", () => {
	test("Cursor SDK provider invokes native search without creating a sidecar", async () => {
		const create = sidecar();
		const ctx = context("key");
		ctx.model.provider = CURSOR_SDK_PROVIDER_ID;
		const signal = new AbortController().signal;
		const onUpdate = mock(() => {});
		expect(await executeCursorWebSearchTool(params, ctx, signal, onUpdate)).toEqual(nativeResult);
		expect(ctx.invokeTool).toHaveBeenCalledWith(params, { signal, onUpdate });
		expect(ctx.modelRegistry.authStorage.getApiKey).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	test("aborted cursor-sdk calls do not fall back", async () => {
		const create = sidecar();
		const ctx = context("key");
		ctx.model.provider = CURSOR_SDK_PROVIDER_ID;
		await expect(executeCursorWebSearchTool(params, ctx, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
		expect(ctx.invokeTool).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	test("aborted missing-key path does not fall back", async () => {
		const create = sidecar();
		const ctx = context();
		await expect(executeCursorWebSearchTool(params, ctx, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
		expect(ctx.invokeTool).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	test("missing credentials use native search", async () => {
		const create = sidecar();
		const ctx = context();
		expect(await executeCursorWebSearchTool(params, ctx)).toEqual(nativeResult);
		expect(ctx.invokeTool).toHaveBeenCalledTimes(1);
		expect(create).not.toHaveBeenCalled();
	});

	test("empty queries use native search", async () => {
		const create = sidecar();
		const ctx = context("key");
		expect(await executeCursorWebSearchTool({ query: "  " }, ctx)).toEqual(nativeResult);
		expect(create).not.toHaveBeenCalled();
	});

	test("successful sidecar search returns its answer instead of native search", async () => {
		sidecar();
		const ctx = context("key");
		expect(await executeCursorWebSearchTool(params, ctx)).toEqual({ content: [{ type: "text", text: "Cursor answer" }] });
		expect(ctx.invokeTool).not.toHaveBeenCalled();
	});

	test("sidecar failure falls back to native search", async () => {
		__testUtils.setCreateAgent(async () => { throw new Error("sidecar failed"); });
		const ctx = context("key");
		expect(await executeCursorWebSearchTool(params, ctx)).toEqual(nativeResult);
		expect(ctx.invokeTool).toHaveBeenCalledTimes(1);
	});

	test("answers without a performed search fall back to native search", async () => {
		sidecar(false);
		const ctx = context("key");
		expect(await executeCursorWebSearchTool(params, ctx)).toEqual(nativeResult);
		expect(ctx.invokeTool).toHaveBeenCalledTimes(1);
	});

	test("AbortError is rethrown without native fallback", async () => {
		const error = new DOMException("Cancelled", "AbortError");
		__testUtils.setCreateAgent(async () => { throw error; });
		const ctx = context("key");
		await expect(executeCursorWebSearchTool(params, ctx)).rejects.toBe(error);
		expect(ctx.invokeTool).not.toHaveBeenCalled();
	});

	test("an aborted signal never falls back even for a different error", async () => {
		const controller = new AbortController();
		const error = new Error("cancelled while creating");
		const ctx = context("key");
		ctx.modelRegistry.authStorage.getApiKey = mock(async () => { controller.abort(); throw error; });
		await expect(executeCursorWebSearchTool(params, ctx, controller.signal)).rejects.toBe(error);
		expect(ctx.invokeTool).not.toHaveBeenCalled();
	});

	test("unavailable native search preserves the sidecar error", async () => {
		const error = new CursorSearchNotPerformedError();
		__testUtils.setCreateAgent(async () => { throw error; });
		await expect(executeCursorWebSearchTool(params, { ...context("key"), invokeTool: undefined })).rejects.toBe(error);
	});

	test("unavailable native search without a sidecar error is explicit", async () => {
		await expect(executeCursorWebSearchTool(params, { cwd: "/tmp" })).rejects.toThrow("OMP native web_search is unavailable");
	});

	test("N/A auth values fall through to provider credentials", async () => {
		sidecar();
		const ctx = context("N/A");
		const getApiKeyForProvider = mock(async () => "provider-key");
		expect(await executeCursorWebSearchTool(params, {
			...ctx,
			modelRegistry: { ...ctx.modelRegistry, getApiKeyForProvider },
		})).toEqual({ content: [{ type: "text", text: "Cursor answer" }] });
		expect(ctx.invokeTool).not.toHaveBeenCalled();
	});

	test("N/A is not treated as an environment API key", async () => {
		process.env[CURSOR_API_KEY_ENV_VAR] = "N/A";
		const create = sidecar();
		const ctx = context("N/A");
		expect(await executeCursorWebSearchTool(params, ctx)).toEqual(nativeResult);
		expect(create).not.toHaveBeenCalled();
	});
});
