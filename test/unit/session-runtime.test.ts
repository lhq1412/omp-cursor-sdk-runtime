import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import type { SDKAgent } from "@cursor/sdk";
import { credentialScopeId } from "../../src/auth.ts";
import { computeContextFingerprint } from "../../src/context.ts";
import { CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE } from "../../src/constants.ts";
import {
	prepareTurn,
	commitTurn,
	finishTurnFailed,
	finishLiveKeepAgent,
	disposeRuntimeForScope,
	invalidateRuntime,
	agentConfigMismatch,
	__testUtils as runtimeTestUtils,
	type PreparedTurn,
} from "../../src/session-runtime.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils, getCursorSessionOwner, ownerForRequest, withCursorSessionOwner } from "../../src/session-scope.ts";
import { parseResumeEntryData, registerCursorSessionResume, __testUtils as resumeTestUtils } from "../../src/session-resume.ts";

const modelLimits = { contextWindow: 200_000, maxTokens: 20_000 };

function fakeAgent(id: string, sends: string[] = []): SDKAgent {
	return {
		agentId: id,
		close() {},
		async [Symbol.asyncDispose]() {},
		send() {
			sends.push(id);
			throw new Error("send() should not run in prepareTurn tests");
		},
	} as unknown as SDKAgent;
}

function userContext(text: string): Context {
	return { messages: [{ role: "user", content: text, timestamp: 1 } as Context["messages"][number]] };
}

function historyThenContinue(): Context {
	return {
		messages: [
			{ role: "user", content: "target is important.ts", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
			{ role: "user", content: "continue that edit", timestamp: 3 },
		],
	} as Context;
}

function toolResultContext(): Context {
	return {
		messages: [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 1,
			},
		],
	} as Context;
}

function registerResume(mode: "write" | "swallow" = "write", sessionId = "sess-1"): {
	appended: Array<{ type: string; data: unknown }>;
	sessionFile: string;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	ctx: { cwd: string; sessionManager: Record<string, unknown> };
	branch: Array<{ type: string; id: string; parentId: string | null; customType?: string; data?: unknown; message?: { role: string } }>;
} {
	const appended: Array<{ type: string; data: unknown }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sessionFile = join(mkdtempSync(join(tmpdir(), "omp-csr-")), "session.jsonl");
	writeFileSync(sessionFile, "");
	scopeTestUtils.set("/tmp/project", sessionFile, sessionId);
	const branch: Array<{ type: string; id: string; parentId: string | null; customType?: string; data?: unknown; message?: { role: string } }> = [];
	const ctx = {
		cwd: "/tmp/project",
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
			getBranch: () => branch,
			getEntries: () => branch,
		},
	};
	const pi = {
		appendEntry(customType: string, data?: unknown) {
			appended.push({ type: customType, data });
			if (mode === "swallow") return;
			appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`);
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	registerCursorSessionResume(pi as never);
	void handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
	return { appended, sessionFile, handlers, ctx, branch };
}

function seedCommittedHandle(sessionFile: string, context: Context, agentId = "agent-old"): void {
	resumeTestUtils.state.activeHandle = {
		version: 3,
		runtime: "local",
		agentId,
		scopeKey: sessionFile,
		sessionFile,
		sessionId: "sess-1",
		cwd: "/tmp/project",
		poolKey: "main",
		branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
		compactionGeneration: 0,
		sendState: {
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(context),
			incrementalSendCount: 0,
		},
		createdAt: "2026-09-08T00:00:00.000Z",
		storeIdentity: { version: 1, stateRoot: "/tmp/store" },
		state: "committed",
		agentInstanceId: "main",
		credentialScopeId: credentialScopeId("test-key"),
	};
}

describe("session runtime", () => {
	test("child invalidation cannot abort a parent preparation or redirect its committed writer", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		const parent = registerResume("write", "parent");
		const parentOwner = getCursorSessionOwner();
		let opened!: () => void;
		let finishOpen!: () => void;
		const opening = new Promise<void>((resolve) => { opened = resolve; });
		const gate = new Promise<void>((resolve) => { finishOpen = resolve; });
		runtimeTestUtils.setOpenAgent(async () => {
			if (getCursorSessionOwner() === parentOwner) {
				opened();
				await gate;
				return fakeAgent("agent-parent");
			}
			return fakeAgent("agent-child");
		});
		const input = {
			cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, modelLimits,
			context: userContext("parent request"), grantedTools: [],
		};
		const parentTurn = withCursorSessionOwner(parentOwner, () => prepareTurn(input));
		await opening;
		const child = registerResume("write", "child");
		const childTurn = await prepareTurn({ ...input, context: userContext("child request") });
		invalidateRuntime("child compacted");
		finishOpen();
		const prepared = await parentTurn;
		expect(prepared.slot.preparation?.signal.aborted).toBe(false);
		expect(childTurn.slot.preparation?.signal.aborted).toBe(true);
		// Commit deliberately runs while the caller owns the child.
		commitTurn(prepared.slot, input.context, false);
		await parent.handlers.get("turn_end")?.[0]?.({}, parent.ctx);
		const parentCommit = parent.appended.find((entry) => parseResumeEntryData(entry.data)?.state === "committed");
		expect(parentCommit?.data).toMatchObject({
			agentId: "agent-parent", scopeKey: parent.sessionFile, sessionId: "parent",
		});
		expect(child.appended.some((entry) => parseResumeEntryData(entry.data)?.agentId === "agent-parent")).toBe(false);
		await disposeRuntimeForScope(parentOwner.scopeKey);
		await disposeRuntimeForScope(childTurn.slot.scopeKey);
	});

	test("a one-shot title owner never reuses or persists the parent agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		const parent = registerResume("write", "parent");
		const parentOwner = getCursorSessionOwner();
		let opens = 0;
		runtimeTestUtils.setOpenAgent(async () => fakeAgent(`agent-${++opens}`));
		const input = {
			cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, modelLimits,
			context: userContext("parent request"), grantedTools: [],
		};
		const parentTurn = await prepareTurn(input);
		const titleOwner = ownerForRequest();
		const titleTurn = await withCursorSessionOwner(titleOwner, () => prepareTurn({
			...input, context: userContext("generate title"),
		}));
		commitTurn(titleTurn.slot, input.context, false);
		await withCursorSessionOwner(titleOwner, () => disposeRuntimeForScope());
		expect(parentTurn.slot.preparation?.signal.aborted).toBe(false);
		expect(opens).toBe(2);
		commitTurn(parentTurn.slot, input.context, false);
		await parent.handlers.get("turn_end")?.[0]?.({}, parent.ctx);
		expect(parent.appended.map((entry) => parseResumeEntryData(entry.data)?.agentId)).toEqual(["agent-1"]);
		await disposeRuntimeForScope(parentOwner.scopeKey);
	});

	for (const interruption of ["abort", "scope", "invalidate", "newer"] as const) {
		test(`late initialization cannot attach after ${interruption}`, async () => {
			runtimeTestUtils.clear();
			liveRunTestUtils.clear();
			scopeTestUtils.reset();
			resumeTestUtils.reset();
			registerResume();
			let resolveOpen!: (agent: SDKAgent) => void;
			let entered!: () => void;
			const opening = new Promise<SDKAgent>((resolve) => { resolveOpen = resolve; });
			const started = new Promise<void>((resolve) => { entered = resolve; });
			let signal: AbortSignal | undefined;
			runtimeTestUtils.setOpenAgent((input) => {
				signal = input.signal;
				entered();
				return opening;
			});
			const controller = new AbortController();
			const input = {
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: userContext("old"), grantedTools: [],
			};
			const old = prepareTurn({ ...input, signal: controller.signal });
			await Promise.race([
				started,
				old.then(() => { throw new Error("prepareTurn finished before opening the agent"); }),
			]);
			let newer: PreparedTurn | undefined;
			if (interruption === "abort") controller.abort();
			else if (interruption === "scope") await disposeRuntimeForScope();
			else if (interruption === "invalidate") invalidateRuntime("compaction");
			else {
				runtimeTestUtils.setOpenAgent(async () => fakeAgent("new"));
				newer = await prepareTurn({ ...input, context: userContext("new") });
			}
			expect(signal?.aborted).toBe(true);
			let disposed = 0;
			resolveOpen({ ...fakeAgent("old"), async [Symbol.asyncDispose]() { disposed++; } } as SDKAgent);
			await expect(old).rejects.toThrow();
			expect(disposed).toBe(1);
			expect([...runtimeTestUtils.slots.values()].some((slot) => slot.agent?.agentId === "old")).toBe(false);
			if (newer) expect(runtimeTestUtils.slots.get(newer.slot.key)?.agent?.agentId).toBe("new");
		});
	}

	test("late old completion and cleanup leave the newer route committed", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		let opens = 0;
		runtimeTestUtils.setOpenAgent(async () => fakeAgent(`agent-${++opens}`));
		const input = {
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: userContext("old"), grantedTools: [],
		};
		const old = await prepareTurn(input);
		const context = userContext("new");
		const newer = await prepareTurn({ ...input, context });
		commitTurn(newer.slot, context, false);
		const pending = structuredClone(resumeTestUtils.state.pendingHandle);
		commitTurn(old.slot, input.context, false);
		await finishTurnFailed(old.slot, "late error");
		await finishLiveKeepAgent(old.slot, "late completion");
		expect(newer.live.cancelled).toBe(false);
		expect(newer.slot.agent?.agentId).toBe("agent-2");
		expect(newer.slot.bindingState).toBe("committed");
		expect(resumeTestUtils.state.pendingHandle).toEqual(pending);
	});

	test("rejects oversized bootstrap before opening an SDK agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		let opens = 0;
		runtimeTestUtils.setOpenAgent(async () => {
			opens += 1;
			return fakeAgent("agent-unexpected");
		});
		await expect(prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			modelLimits: { contextWindow: 2000, maxTokens: 500 },
			context: userContext("x".repeat(2000)),
			grantedTools: [],
		})).rejects.toThrow(/context window exceeded/i);
		expect(opens).toBe(0);
	});

	test("resuming an identical committed context does not replay its user input", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { sessionFile } = registerResume();
		const context = userContext("Already executed request");
		seedCommittedHandle(sessionFile, context);
		const resumedIds: Array<string | undefined> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			resumedIds.push(input.savedAgentId);
			return fakeAgent("agent-old");
		});
		const prepared = await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			modelLimits,
			context,
			grantedTools: [],
		});
		expect(resumedIds).toEqual(["agent-old"]);
		expect(prepared.prompt?.text).toMatch(/continue/i);
		expect(prepared.prompt?.text).not.toContain("Already executed request");
	});

	test("rejects orphaned tool results before opening an agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		let opens = 0;
		runtimeTestUtils.setOpenAgent(async () => {
			opens += 1;
			return fakeAgent("agent-unexpected");
		});
		await expect(
			prepareTurn({ modelLimits, cwd: "/tmp/project",
				agentInstanceId: "main",
				apiKey: "test-key",
				modelSelection: { id: "composer-2.5" },
				context: toolResultContext(),
				grantedTools: [], }),
		).rejects.toThrow();
		expect(opens).toBe(0);
	});

	test("recovery never resumes even a matching committed handle", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { sessionFile } = registerResume();
		const context = {
			messages: [
				{ role: "user", content: "Read a.ts and summarize it", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }], timestamp: 2 },
				...toolResultContext().messages,
			],
		} as Context;
		seedCommittedHandle(sessionFile, context);
		const resumedIds: Array<string | undefined> = [];
		let history: Context["messages"] | undefined;
		runtimeTestUtils.setOpenAgent(async (input) => {
			resumedIds.push(input.savedAgentId);
			history = input.bootstrapHistory;
			return fakeAgent("agent-new");
		});
		const prepared = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context, grantedTools: [],
		});
		expect(resumedIds).toEqual([undefined]);
		expect(prepared.continuing).toBe(false);
		expect(prepared.incremental).toBe(false);
		expect(history).toEqual(context.messages);
		expect(prepared.prompt?.text).not.toContain("Read a.ts and summarize it");
	});

	test("bootstraps reconstructed history on a new agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		let history: Context["messages"] | undefined;
		runtimeTestUtils.setOpenAgent(async (input) => {
			history = input.bootstrapHistory;
			return fakeAgent("agent-new");
		});
		const prepared = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: historyThenContinue(),
			grantedTools: [], });
		expect(history).toEqual(historyThenContinue().messages.slice(0, -1));
		expect(prepared.incremental).toBe(false);
	});

	test("invalidates a committed binding before reusing an agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { appended } = registerResume();
		let opens = 0;
		runtimeTestUtils.setOpenAgent(async () => {
			opens += 1;
			return fakeAgent("agent-local-1");
		});
		const firstContext = userContext("first");
		const first = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: firstContext,
			grantedTools: [], });
		first.slot.bindingState = "committed";
		first.slot.sendState = {
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(firstContext),
			incrementalSendCount: 0,
		};
		liveRunTestUtils.clear();
		const secondContext = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 } as Context["messages"][number],
				{ role: "user", content: "second", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;
		const second = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: secondContext,
			grantedTools: [], });
		expect(opens).toBe(1);
		expect(second.incremental).toBe(true);
		expect(second.prompt?.text).toBe("second");
		expect(appended.some((entry) => (entry.data as { state?: string }).state === "in-flight")).toBe(true);
	});

	test("reopens the agent when the native webSearch grant changes", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		const opens: boolean[] = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push(Boolean(input.includeWebSearch));
			return fakeAgent(`agent-${opens.length}`);
		});
		const firstContext = userContext("first");
		const first = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: firstContext, grantedTools: [], includeWebSearch: true,
		});
		first.slot.bindingState = "committed";
		first.slot.sendState = {
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(firstContext),
			incrementalSendCount: 0,
		};
		liveRunTestUtils.clear();
		const secondContext = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 } as Context["messages"][number],
				{ role: "user", content: "second", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;
		await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: secondContext, grantedTools: [], includeWebSearch: false,
		});
		expect(opens).toEqual([true, false]);
	});

	test("creates a new agent and bootstraps history when cwd or credentials change", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { appended } = registerResume();
		const opens: Array<{ savedAgentId?: string; cwd: string }> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId, cwd: input.cwd });
			return fakeAgent(`agent-${opens.length}`);
		});
		const context = historyThenContinue();
		const first = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "key-a",
			modelSelection: { id: "composer-2.5" },
			context,
			grantedTools: [], });
		first.slot.bindingState = "committed";
		first.slot.sendState = {
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(context),
			incrementalSendCount: 0,
		};
		liveRunTestUtils.clear();
		expect(agentConfigMismatch(first.slot, "/tmp/other", credentialScopeId("key-a"))).toBe(true);
		expect(agentConfigMismatch(first.slot, first.slot.cwd, credentialScopeId("key-b"))).toBe(true);
		const second = await prepareTurn({ modelLimits, cwd: "/tmp/other",
			agentInstanceId: "main",
			apiKey: "key-b",
			modelSelection: { id: "composer-2.5" },
			context,
			grantedTools: [], });
		expect(opens).toHaveLength(2);
		expect(opens[1]?.savedAgentId).toBeUndefined();
		expect(opens[1]?.cwd).toContain("/tmp/other");
		expect(second.incremental).toBe(false);
		expect(second.prompt?.text).toContain("continue that edit");
		const dirty = appended.find((entry) => (entry.data as { state?: string }).state === "dirty");
		expect(parseResumeEntryData(dirty?.data)?.cwd).toBe(resolve("/tmp/project"));
		expect(parseResumeEntryData(dirty?.data)?.agentId).toBe("agent-1");
	});

	test("resumes a matching committed handle incrementally instead of re-sending history", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { sessionFile } = registerResume();
		const firstContext = userContext("first");
		seedCommittedHandle(sessionFile, firstContext);
		const opens: Array<{ savedAgentId?: string }> = [];
		const histories: Array<Context["messages"] | undefined> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId });
			histories.push(input.bootstrapHistory);
			return fakeAgent(input.savedAgentId ?? "agent-new");
		});
		const secondContext = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 } as Context["messages"][number],
				{ role: "user", content: "second", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;
		const prepared = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: secondContext,
			grantedTools: [], });
		expect(opens).toEqual([{ savedAgentId: "agent-old" }]);
		expect(histories).toEqual([undefined]);
		expect(prepared.incremental).toBe(true);
		expect(prepared.prompt?.text).toBe("second");
	});

	test("does not resume a committed handle whose cwd differs from this turn", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { sessionFile } = registerResume();
		const firstContext = userContext("first");
		seedCommittedHandle(sessionFile, firstContext);
		const opens: Array<{ savedAgentId?: string; cwd: string }> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId, cwd: input.cwd });
			return fakeAgent("agent-new");
		});
		const secondContext = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 } as Context["messages"][number],
				{ role: "user", content: "second", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;
		const prepared = await prepareTurn({ modelLimits, cwd: "/tmp/other",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: secondContext,
			grantedTools: [], });
		expect(opens).toEqual([{ savedAgentId: undefined, cwd: expect.stringContaining("/tmp/other") }]);
		expect(prepared.incremental).toBe(false);
	});

	test("refuses parked continuation after cwd or credentials change", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		const opens: string[] = [];
		runtimeTestUtils.setOpenAgent(async () => {
			const id = `agent-${opens.length + 1}`;
			opens.push(id);
			return fakeAgent(id);
		});
		await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "key-a",
			modelSelection: { id: "composer-2.5" },
			context: userContext("first"),
			grantedTools: [], });
		await expect(
			prepareTurn({ modelLimits, cwd: "/tmp/other",
				agentInstanceId: "main",
				apiKey: "key-b",
				modelSelection: { id: "composer-2.5" },
				context: toolResultContext(),
				grantedTools: [], }),
		).rejects.toThrow(/cwd or credentials changed/);
		expect(opens).toEqual(["agent-1"]);
	});

	test("does not start send when in-flight invalidation is swallowed by storage", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume("swallow");
		const sends: string[] = [];
		let opens = 0;
		runtimeTestUtils.setOpenAgent(async () => {
			opens += 1;
			return fakeAgent("agent-local-1", sends);
		});
		const firstContext = userContext("first");
		const first = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: firstContext,
			grantedTools: [], });
		first.slot.bindingState = "committed";
		first.slot.sendState = {
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(firstContext),
			incrementalSendCount: 0,
		};
		liveRunTestUtils.clear();
		const secondContext = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 } as Context["messages"][number],
				{ role: "user", content: "second", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;
		await expect(
			prepareTurn({ modelLimits, cwd: "/tmp/project",
				agentInstanceId: "main",
				apiKey: "test-key",
				modelSelection: { id: "composer-2.5" },
				context: secondContext,
				grantedTools: [], }),
		).rejects.toThrow(/not persisted/);
		expect(opens).toBe(1);
		expect(sends).toEqual([]);
	});

	test("bootstraps after a failed turn instead of incrementing leftover sendState", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		const opens: Array<{ savedAgentId?: string }> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId });
			return fakeAgent(input.savedAgentId ?? `agent-${opens.length}`);
		});
		const firstContext = historyThenContinue();
		const first = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: firstContext,
			grantedTools: [], });
		commitTurn(first.slot, firstContext, first.incremental);
		liveRunTestUtils.clear();
		const failedContext = {
			messages: [
				...firstContext.messages,
				{ role: "user", content: "Continue without repeating completed work", timestamp: 4 },
			],
		} as Context;
		const failed = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: failedContext,
			grantedTools: [], });
		expect(failed.incremental).toBe(true);
		await finishTurnFailed(failed.slot, "run error");
		const recovered = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: failedContext,
			grantedTools: [], });
		expect(opens.at(-1)?.savedAgentId).toBeUndefined();
		expect(recovered.incremental).toBe(false);
		expect(recovered.prompt?.text).toContain("Continue without repeating completed work");
	});

	test("commits the agent's execution cwd and does not resume it from the session cwd", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { appended, handlers, ctx, branch } = registerResume();
		const opens: Array<{ savedAgentId?: string; cwd: string }> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId, cwd: input.cwd });
			return fakeAgent(input.savedAgentId ?? `agent-${opens.length}`);
		});
		const firstContext = userContext("first");
		const first = await prepareTurn({ modelLimits, cwd: "/tmp/other",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: firstContext,
			grantedTools: [], });
		commitTurn(first.slot, firstContext, first.incremental);
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		const committed = appended.map((entry) => parseResumeEntryData(entry.data)).findLast((entry) => entry?.state === "committed");
		expect(committed?.cwd).toBe(resolve("/tmp/other"));
		expect(committed?.agentId).toBe("agent-1");
		branch.push({
			type: "custom",
			id: "r1",
			parentId: null,
			customType: CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
			data: committed,
		});

		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId, cwd: input.cwd });
			return fakeAgent(input.savedAgentId ?? `agent-${opens.length}`);
		});
		void handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		const secondContext = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 } as Context["messages"][number],
				{ role: "user", content: "second", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;
		const resumed = await prepareTurn({ modelLimits, cwd: "/tmp/other",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: secondContext,
			grantedTools: [], });
		expect(resumed.incremental).toBe(true);
		expect(opens.at(-1)).toEqual({ savedAgentId: "agent-1", cwd: expect.stringContaining("/tmp/other") });

		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId, cwd: input.cwd });
			return fakeAgent(input.savedAgentId ?? `agent-${opens.length}`);
		});
		void handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		const fromSessionCwd = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: secondContext,
			grantedTools: [], });
		expect(opens.at(-1)?.savedAgentId).toBeUndefined();
		expect(opens.at(-1)?.cwd).toContain("/tmp/project");
		expect(fromSessionCwd.incremental).toBe(false);
	});

	test("opens create/resume with this turn's ModelSelection", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		const modelSelection = {
			id: "composer-2.5",
			params: [
				{ id: "fast", value: "true" },
				{ id: "context", value: "1m" },
				{ id: "effort", value: "high" },
			],
		};
		const opened: unknown[] = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opened.push(input.model);
			return fakeAgent("agent-1");
		});
		await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection,
			context: userContext("first"),
			grantedTools: [], });
		expect(opened).toEqual([modelSelection]);
		expect(opened[0]).toBe(modelSelection);
	});

	test("parked continuation keeps the original agent and ignores a new ModelSelection", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		const opened: unknown[] = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opened.push(input.model);
			return fakeAgent(`agent-${opened.length + 1}`);
		});
		await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
			context: userContext("first"),
			grantedTools: [], });
		const next = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
			context: toolResultContext(),
			grantedTools: [], });
		expect(opened).toHaveLength(1);
		expect(next.continuing).toBe(true);
	});
});
