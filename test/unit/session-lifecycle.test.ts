import { afterEach, describe, expect, test } from "bun:test";
import { CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { computeContextFingerprint } from "../../src/context.ts";
import { registerCursorSessionLifecycle, __testUtils as lifecycleTestUtils } from "../../src/session-lifecycle.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Context } from "@oh-my-pi/pi-ai";

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
	event: Record<string, unknown> = {},
): Promise<unknown> {
	return handlers.get(type)?.[0]?.({ type, ...event }, ctx);
}

describe("session lifecycle auto compact", () => {
	afterEach(() => {
		lifecycleTestUtils.clear();
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

	test("does not cancel auto compact for other providers", async () => {
		const { handlers, ctx } = hooks("anthropic");
		await emit(handlers, "auto_compaction_start", ctx);
		expect(await emit(handlers, "session_before_compact", ctx)).toBeUndefined();
	});

	test("reuses a covering Cursor summary as custom compaction for another provider", async () => {
		const { handlers, ctx } = hooks("anthropic");
		const messages = [
			{ role: "user", content: "a", timestamp: 1 },
			{ role: "user", content: "b", timestamp: 2 },
		] as Context["messages"];
		const fingerprint = computeContextFingerprint({ systemPrompt: ["sys"], messages });
		lifecycleTestUtils.remember({
			text: "S",
			agentId: "agent-1",
			rootBlobId: "blob-1",
			sourceContextFingerprint: fingerprint,
			generation: 0,
			occupancyAfter: 47_000,
		}, `${scopeTestUtils.EPHEMERAL_SESSION_SCOPE_PREFIX}sess-1`);
		const result = await emit(handlers, "session_before_compact", ctx, {
			preparation: {
				messagesToSummarize: messages.slice(0, 1),
				firstKeptEntryId: "keep-b",
				tokensBefore: 180_000,
			},
		});
		expect(result).toEqual({
			compaction: {
				summary: "S",
				firstKeptEntryId: "keep-b",
				tokensBefore: 180_000,
				preserveData: { cursorSdkPortableSummary: { generation: 0, occupancyAfter: 47_000 } },
			},
		});
	});

	test("does not reuse a Cursor summary that does not cover the dropped prefix", async () => {
		const { handlers, ctx } = hooks("anthropic");
		const seen = [{ role: "user", content: "a", timestamp: 1 }] as Context["messages"];
		const dropped = [
			{ role: "user", content: "a", timestamp: 1 },
			{ role: "user", content: "b", timestamp: 2 },
		] as Context["messages"];
		lifecycleTestUtils.remember({
			text: "S",
			agentId: "agent-1",
			rootBlobId: "blob-1",
			sourceContextFingerprint: computeContextFingerprint({ systemPrompt: ["sys"], messages: seen }),
			generation: 0,
		}, `${scopeTestUtils.EPHEMERAL_SESSION_SCOPE_PREFIX}sess-1`);
		expect(await emit(handlers, "session_before_compact", ctx, {
			preparation: { messagesToSummarize: dropped, firstKeptEntryId: "keep", tokensBefore: 180_000 },
		})).toBeUndefined();
	});
});
