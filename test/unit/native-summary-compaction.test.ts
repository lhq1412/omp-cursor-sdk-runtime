import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import type { CompactionEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { locatorFor, projectSourceHistoryUnits, stableMessageDigest } from "../../src/context.ts";
import {
	commitOwnMaterialization,
	noteMainSessionStop,
	onAgentEnd,
	onSessionBeforeCompact,
	resolveMaterializationBoundary,
	__testUtils as compactionTestUtils,
	type PendingCursorCompaction,
} from "../../src/native-summary-compaction.ts";
import { registerCursorSessionLifecycle } from "../../src/session-lifecycle.ts";
import {
	attemptNativeCompactionRebase,
	commitTurn,
	disposeRuntimeForScope,
	prepareTurn,
	__testUtils as runtimeTestUtils,
} from "../../src/session-runtime.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils, ownerForContext, withCursorSessionOwner } from "../../src/session-scope.ts";
import type { SDKAgent } from "@cursor/sdk";

function user(text: string, timestamp: number): Context["messages"][number] {
	return { role: "user", content: text, timestamp } as Context["messages"][number];
}

function assistant(text: string, timestamp: number): Context["messages"][number] {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor-sdk-agent",
		provider: "cursor-sdk",
		model: "composer-2.5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	} as Context["messages"][number];
}

function conversation(count: number): Context["messages"] {
	const messages: Context["messages"] = [];
	for (let index = 0; index < count; index += 1) {
		messages.push(user(`u${index}`, (index + 1) * 10));
		messages.push(assistant(`a${index}`, (index + 1) * 10 + 1));
	}
	return messages;
}

function messageEntry(id: string, message: Context["messages"][number], parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date((message as { timestamp: number }).timestamp).toISOString(),
		message,
	} as SessionEntry;
}

function coverage(expanded: number, extra: Partial<PendingCursorCompaction["coverage"]> = {}): PendingCursorCompaction["coverage"] {
	return {
		summary: "S",
		summarizedTurnCount: expanded,
		windowTail: 3,
		units: Array.from({ length: expanded }, (_, index) => ({ kind: "history-turn" as const, sourceUnitOrdinal: index })),
		includesPreviousSummary: false,
		archiveHash: "hash",
		expandedSummarizedTurnCount: expanded,
		...extra,
	};
}

function pending(partial: Partial<PendingCursorCompaction> = {}): PendingCursorCompaction {
	const messages = conversation(5);
	return {
		id: "pending-1",
		scopeKey: "/tmp/session-lifecycle.jsonl",
		sessionId: "sess-1",
		agentInstanceId: "main",
		agentId: "agent-x",
		checkpointRootBlobId: "after",
		summaryGeneration: 1,
		summary: "S(A..B)",
		archiveHash: "hash",
		coverage: coverage(2),
		tokensBefore: 80,
		tokensBeforeSource: "checkpoint-before-summary",
		sourceContextFingerprint: "fp",
		sourceUnits: projectSourceHistoryUnits(messages),
		state: "pending",
		...partial,
	};
}

function hooks() {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	let idle = false;
	let pendingMessages = false;
	const ctx = {
		cwd: "/tmp/project",
		model: { provider: CURSOR_SDK_PROVIDER_ID },
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/tmp/session-lifecycle.jsonl",
		},
		isIdle: () => idle,
		hasPendingMessages: () => pendingMessages,
		setTimeout(callback: (...args: unknown[]) => void, ms?: number) {
			return setTimeout(callback, ms ?? 0);
		},
		clearTimer(timer: ReturnType<typeof setTimeout>) {
			clearTimeout(timer);
		},
		async compact() {},
	} as unknown as ExtensionContext & { setIdle(value: boolean): void; setPending(value: boolean): void };
	(ctx as unknown as { setIdle(value: boolean): void }).setIdle = (value) => { idle = value; };
	(ctx as unknown as { setPending(value: boolean): void }).setPending = (value) => { pendingMessages = value; };
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	registerCursorSessionLifecycle(pi as Pick<ExtensionAPI, "on">);
	return { handlers, ctx, setIdle: (value: boolean) => { idle = value; }, setPending: (value: boolean) => { pendingMessages = value; } };
}

async function emit(
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>,
	type: string,
	ctx: ExtensionContext,
	event: Record<string, unknown> = {},
): Promise<unknown> {
	return handlers.get(type)?.[0]?.({ type, ...event }, ctx);
}

describe("native summary materialization", () => {
	beforeEach(() => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		compactionTestUtils.clear();
		compactionTestUtils.setPollTiming(5, 50);
	});

	afterEach(async () => {
		await disposeRuntimeForScope();
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		compactionTestUtils.clear();
	});

	test("keeps a digest stable after compaction shifts message indexes", () => {
		const message = user("hello", 10);
		const digest = stableMessageDigest(message);
		expect(digest).toBe(stableMessageDigest({ ...message }));
		expect(locatorFor(message).digest).toBe(digest);
	});

	test("keeps an exact user-request retained boundary", () => {
		const messages = conversation(5);
		const entries = messages.map((message, index) => messageEntry(`e${index}`, message, index === 0 ? null : `e${index - 1}`));
		const item = pending({ sourceUnits: projectSourceHistoryUnits(messages), coverage: coverage(3) });
		expect(resolveMaterializationBoundary(item, entries)?.firstKeptEntryId).toBe("e6");
		expect(item.state).toBe("pending");
	});

	test("walks back from an assistant retained point to the previous user request", () => {
		const messages = conversation(3);
		const sourceUnits = projectSourceHistoryUnits(messages);
		sourceUnits[1] = { ...sourceUnits[1]!, firstMessage: locatorFor(messages[3]) };
		const entries = messages.map((message, index) => messageEntry(`e${index}`, message, index === 0 ? null : `e${index - 1}`));
		const item = pending({ sourceUnits, coverage: coverage(1) });
		expect(resolveMaterializationBoundary(item, entries)?.firstKeptEntryId).toBe("e2");
		expect(item.state).toBe("pending");
	});

	test("marks pending stale when the candidate is not on the branch", () => {
		const messages = conversation(5);
		const entries = [messageEntry("other", user("nope", 99))];
		const item = pending({ sourceUnits: projectSourceHistoryUnits(messages), coverage: coverage(2) });
		expect(resolveMaterializationBoundary(item, entries)).toBeUndefined();
		expect(item.state).toBe("stale");
	});

	test("marks pending stale when the candidate is earlier than the previous firstKept", () => {
		const messages = conversation(5);
		const entries: SessionEntry[] = [
			...messages.map((message, index) => messageEntry(`e${index}`, message, index === 0 ? null : `e${index - 1}`)),
			{
				type: "compaction",
				id: "c1",
				parentId: "e4",
				timestamp: new Date(80).toISOString(),
				summary: "old",
				firstKeptEntryId: "e8",
				tokensBefore: 10,
			} as CompactionEntry,
		];
		const item = pending({
			sourceUnits: projectSourceHistoryUnits(messages),
			coverage: coverage(2, { includesPreviousSummary: true }),
		});
		expect(resolveMaterializationBoundary(item, entries)).toBeUndefined();
		expect(item.state).toBe("stale");
	});

	test("marks pending stale when a previous compaction exists without previous-summary coverage", () => {
		const messages = conversation(5);
		const entries: SessionEntry[] = [
			...messages.map((message, index) => messageEntry(`e${index}`, message, index === 0 ? null : `e${index - 1}`)),
			{
				type: "compaction",
				id: "c1",
				parentId: "e4",
				timestamp: new Date(80).toISOString(),
				summary: "old",
				firstKeptEntryId: "e4",
				tokensBefore: 10,
			} as CompactionEntry,
		];
		const item = pending({
			sourceUnits: projectSourceHistoryUnits(messages),
			coverage: coverage(2, { includesPreviousSummary: false }),
		});
		expect(resolveMaterializationBoundary(item, entries)).toBeUndefined();
		expect(item.state).toBe("stale");
	});

	test("session_before_compact returns a Cursor CompactionResult for an own attempt", () => {
		const { handlers, ctx } = hooks();
		const messages = conversation(5);
		const entries = messages.map((message, index) => messageEntry(`e${index}`, message, index === 0 ? null : `e${index - 1}`));
		const item = pending({ sourceUnits: projectSourceHistoryUnits(messages) });
		compactionTestUtils.stagePending(item);
		const attempt = compactionTestUtils.beginAttempt(item, { id: "attempt-1" });
		const result = onSessionBeforeCompact({
			type: "session_before_compact",
			preparation: { tokensBefore: 12 } as never,
			branchEntries: entries,
			signal: new AbortController().signal,
		}, ctx);
		expect(result).toEqual({
			compaction: {
				summary: "S(A..B)",
				firstKeptEntryId: "e4",
				tokensBefore: 80,
				details: {
					kind: "cursor-sdk-native-summary",
					version: 1,
					materializationId: attempt.id,
					agentId: "agent-x",
					checkpointRootBlobId: "after",
					summaryGeneration: 1,
					archiveHash: "hash",
					tokensBeforeSource: "checkpoint-before-summary",
				},
			},
		});
		expect(handlers.size).toBeGreaterThan(0);
	});

	test("terminal agent_end without session_stop keeps pending", () => {
		const { ctx } = hooks();
		compactionTestUtils.stagePending(pending());
		onAgentEnd({ willContinue: false }, ctx);
		expect(compactionTestUtils.getPending("sess-1")?.state).toBe("pending");
	});

	test("session_stop then agent_end(willContinue) consumes the marker and keeps pending", () => {
		const { ctx } = hooks();
		compactionTestUtils.stagePending(pending());
		noteMainSessionStop("sess-1");
		onAgentEnd({ willContinue: true }, ctx);
		expect(compactionTestUtils.mainSettleCandidates.has("sess-1")).toBe(false);
		expect(compactionTestUtils.getPending("sess-1")?.state).toBe("pending");
	});

	test("materializes after agent_end once isIdle becomes true", async () => {
		const { ctx, setIdle } = hooks();
		const messages = conversation(5);
		const entries = messages.map((message, index) => messageEntry(`e${index}`, message, index === 0 ? null : `e${index - 1}`));
		let compactCalls = 0;
		ctx.compact = async () => {
			compactCalls += 1;
			const item = compactionTestUtils.getPending("sess-1");
			if (!item) throw new Error("missing pending");
			const result = onSessionBeforeCompact({
				type: "session_before_compact",
				preparation: { tokensBefore: 12 } as never,
				branchEntries: entries,
				signal: new AbortController().signal,
			}, ctx);
			if (!result || !("compaction" in result) || !result.compaction) throw new Error("expected compaction");
			commitOwnMaterialization({
				type: "session_compact",
				fromExtension: true,
				compactionEntry: {
					type: "compaction",
					id: "cmp-1",
					parentId: "e4",
					timestamp: new Date(1000).toISOString(),
					summary: result.compaction.summary,
					firstKeptEntryId: result.compaction.firstKeptEntryId,
					tokensBefore: result.compaction.tokensBefore,
					details: result.compaction.details,
				} as CompactionEntry,
			}, ctx);
		};
		compactionTestUtils.stagePending(pending({ sourceUnits: projectSourceHistoryUnits(messages) }));
		noteMainSessionStop("sess-1");
		onAgentEnd({ willContinue: false }, ctx);
		expect(compactCalls).toBe(0);
		setIdle(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(compactCalls).toBe(1);
		expect(compactionTestUtils.getPending("sess-1")?.state).toBe("committed");
	});

	test("prepareCompaction gate returns pending to retry", async () => {
		const { ctx, setIdle } = hooks();
		ctx.compact = async () => {
			throw new Error("Nothing to compact (session too small)");
		};
		compactionTestUtils.stagePending(pending());
		noteMainSessionStop("sess-1");
		onAgentEnd({ willContinue: false }, ctx);
		setIdle(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(compactionTestUtils.getPending("sess-1")?.state).toBe("pending");
		expect(compactionTestUtils.getPending("sess-1")?.lastAttemptError).toContain("Nothing to compact");
	});

	test("ordinary session_compact clears pending", async () => {
		const { handlers, ctx } = hooks();
		compactionTestUtils.stagePending(pending());
		await emit(handlers, "session_compact", ctx, { fromExtension: false, compactionEntry: { details: {} } });
		expect(compactionTestUtils.getPending("sess-1")).toBeUndefined();
	});

	test("navigation clears coordinator state", async () => {
		const { handlers, ctx } = hooks();
		compactionTestUtils.stagePending(pending());
		noteMainSessionStop("sess-1");
		await emit(handlers, "session_before_tree", ctx);
		expect(compactionTestUtils.getPending("sess-1")).toBeUndefined();
		expect(compactionTestUtils.mainSettleCandidates.has("sess-1")).toBe(false);
	});

	test("lazy rebase locates knownTail after index shift and then stays incremental", async () => {
		const { ctx } = hooks();
		const owner = ownerForContext(ctx);
		runtimeTestUtils.setOpenAgent(async () => ({
			agentId: "agent-x",
			close() {},
			async [Symbol.asyncDispose]() {},
		} as SDKAgent));
		const original = conversation(5);
		const first = { messages: original } as Context;
		const turn = await withCursorSessionOwner(owner, () => prepareTurn({
			cwd: ctx.cwd,
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			modelLimits: { contextWindow: 200_000, maxTokens: 20_000 },
			context: first,
			grantedTools: [],
		}));
		commitTurn(turn.slot, first, false);
		const tail = turn.slot.committedContextTail;
		expect(tail).toBeDefined();
		turn.slot.pendingNativeRebase = {
			materializationId: "attempt-1",
			compactionEntryId: "cmp-1",
			compactionTimestamp: 1000,
			checkpointRootBlobId: "after",
			summaryGeneration: 1,
			archiveHash: "hash",
			knownTailLocator: tail,
		};
		const compacted: Context = {
			messages: [
				{ role: "user", content: "S", timestamp: 1000, historyRewriteAt: 1000 } as Context["messages"][number],
				...original.slice(4),
				user("next", 90),
			],
		};
		const rebase = attemptNativeCompactionRebase(turn.slot, compacted);
		expect(rebase?.compactionEntryId).toBe("cmp-1");
		expect(turn.slot.pendingNativeRebase).toBeUndefined();
		expect(turn.slot.sendState.bootstrapped).toBe(true);
		const { planSend } = await import("../../src/context.ts");
		expect(planSend(turn.slot.sendState, compacted)).toMatchObject({ mode: "incremental", resetAgent: false });
	});

	test("foreign assistant after rebase prefix bootstraps", async () => {
		const { ctx } = hooks();
		const owner = ownerForContext(ctx);
		runtimeTestUtils.setOpenAgent(async () => ({
			agentId: "agent-x",
			close() {},
			async [Symbol.asyncDispose]() {},
		} as SDKAgent));
		const original = conversation(3);
		const first = { messages: original } as Context;
		const turn = await withCursorSessionOwner(owner, () => prepareTurn({
			cwd: ctx.cwd,
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			modelLimits: { contextWindow: 200_000, maxTokens: 20_000 },
			context: first,
			grantedTools: [],
		}));
		commitTurn(turn.slot, first, false);
		turn.slot.pendingNativeRebase = {
			materializationId: "attempt-1",
			compactionEntryId: "cmp-1",
			compactionTimestamp: 1000,
			checkpointRootBlobId: "after",
			summaryGeneration: 1,
			archiveHash: "hash",
			knownTailLocator: turn.slot.committedContextTail,
		};
		const compacted: Context = {
			messages: [
				{ role: "user", content: "S", timestamp: 1000, historyRewriteAt: 1000 } as Context["messages"][number],
				...original.slice(2),
				user("claude?", 80),
				{
					role: "assistant",
					content: [{ type: "text", text: "claude" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 81,
				} as Context["messages"][number],
				user("back", 90),
			],
		};
		attemptNativeCompactionRebase(turn.slot, compacted);
		const { planSend } = await import("../../src/context.ts");
		expect(planSend(turn.slot.sendState, compacted)).toMatchObject({
			mode: "bootstrap",
			resetAgent: true,
			reason: "context_divergence",
		});
	});
});
