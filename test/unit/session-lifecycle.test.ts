import { describe, expect, test } from "bun:test";
import { CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { registerCursorSessionLifecycle } from "../../src/session-lifecycle.ts";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

function hooks(provider: string) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const ctx = {
		model: { provider },
		sessionManager: { getSessionId: () => "sess-1" },
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
): Promise<unknown> {
	return handlers.get(type)?.[0]?.({ type }, ctx);
}

describe("session lifecycle auto compact", () => {
	test("cancels auto compact for cursor-sdk and allows manual compact", async () => {
		const { handlers, ctx } = hooks(CURSOR_SDK_PROVIDER_ID);
		expect(await emit(handlers, "session_before_compact", ctx)).toBeUndefined();
		await emit(handlers, "auto_compaction_start", ctx);
		expect(await emit(handlers, "session_before_compact", ctx)).toEqual({ cancel: true });
		await emit(handlers, "auto_compaction_end", ctx);
		expect(await emit(handlers, "session_before_compact", ctx)).toBeUndefined();
	});

	test("does not cancel auto compact for other providers", async () => {
		const { handlers, ctx } = hooks("anthropic");
		await emit(handlers, "auto_compaction_start", ctx);
		expect(await emit(handlers, "session_before_compact", ctx)).toBeUndefined();
	});
});
