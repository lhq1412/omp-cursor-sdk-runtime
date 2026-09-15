import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import type { SDKAgent } from "@cursor/sdk";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { registerCursorSessionLifecycle } from "../../src/session-lifecycle.ts";
import { commitTurn, disposeRuntimeForScope, prepareTurn, __testUtils as runtimeTestUtils } from "../../src/session-runtime.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils, ownerForContext, withCursorSessionOwner } from "../../src/session-scope.ts";

function hooks(provider: string) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const ctx = {
		cwd: "/tmp/project",
		model: { provider },
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/tmp/session-lifecycle.jsonl",
		},
	} as ExtensionContext;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	registerCursorSessionLifecycle(pi as Pick<ExtensionAPI, "on">);
	return { handlers, ctx };
}

async function emit(
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>,
	type: string,
	ctx: ExtensionContext,
	event: Record<string, unknown> = {},
): Promise<unknown> {
	return handlers.get(type)?.[0]?.({ type, ...event }, ctx);
}

describe("session lifecycle", () => {
	beforeEach(() => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
	});

	afterEach(async () => {
		await disposeRuntimeForScope();
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
	});

	test("cancels auto compact for cursor-sdk and allows manual compact", async () => {
		const { handlers, ctx } = hooks(CURSOR_SDK_PROVIDER_ID);
		expect(await emit(handlers, "session_before_compact", ctx)).toBeUndefined();
		await emit(handlers, "auto_compaction_start", ctx);
		expect(await emit(handlers, "session_before_compact", ctx)).toEqual({ cancel: true });
		await emit(handlers, "auto_compaction_end", ctx);
		expect(await emit(handlers, "session_before_compact", ctx)).toBeUndefined();
	});

	test("leaves other providers' auto and manual compaction to OMP", async () => {
		const { handlers, ctx } = hooks("anthropic");
		await emit(handlers, "auto_compaction_start", ctx);
		expect(await emit(handlers, "session_before_compact", ctx)).toBeUndefined();
		expect(await emit(handlers, "session_before_compact", ctx, {
			customInstructions: "Summarize only decisions",
		})).toBeUndefined();
	});

	test.each([
		["manual compaction", "session_compact"],
		["tree pre-navigation", "session_before_tree"],
		["session switch or resume", "session_before_switch"],
		["session fork", "session_before_branch"],
		["tree navigation", "session_tree"],
		["shutdown", "session_shutdown"],
	] as const)("%s invalidates the old runtime before a late commit", async (_name, event) => {
		const { handlers, ctx } = hooks(CURSOR_SDK_PROVIDER_ID);
		const owner = ownerForContext(ctx);
		let disposed = 0;
		runtimeTestUtils.setOpenAgent(async () => ({
			agentId: "agent-old",
			close() {},
			async [Symbol.asyncDispose]() {
				disposed++;
			},
		} as SDKAgent));
		const context = {
			messages: [{ role: "user", content: "old turn", timestamp: 1 } as Context["messages"][number]],
		} as Context;
		const turn = await withCursorSessionOwner(owner, () => prepareTurn({
			cwd: ctx.cwd,
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			modelLimits: { contextWindow: 200_000, maxTokens: 20_000 },
			context,
			grantedTools: [],
		}));

		await emit(handlers, event, ctx);
		commitTurn(turn.slot, context, false);
		await Promise.resolve();
		expect(turn.slot.bindingState).not.toBe("committed");
		expect(disposed).toBe(1);
		await withCursorSessionOwner(owner, () => disposeRuntimeForScope());
	});

});
