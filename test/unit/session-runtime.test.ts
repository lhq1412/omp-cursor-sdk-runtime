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
	agentConfigMismatch,
	__testUtils as runtimeTestUtils,
} from "../../src/session-runtime.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
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

function registerResume(mode: "write" | "swallow" = "write"): {
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
	scopeTestUtils.set("/tmp/project", sessionFile, "sess-1");
	const branch: Array<{ type: string; id: string; parentId: string | null; customType?: string; data?: unknown; message?: { role: string } }> = [];
	const ctx = {
		cwd: "/tmp/project",
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => "sess-1",
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
		runtimeTestUtils.setOpenAgent(async (input) => {
			resumedIds.push(input.savedAgentId);
			return fakeAgent("agent-new");
		});
		const prepared = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context, grantedTools: [],
		});
		expect(resumedIds).toEqual([undefined]);
		expect(prepared.continuing).toBe(false);
		expect(prepared.incremental).toBe(false);
		expect(prepared.prompt?.text).toContain("Read a.ts and summarize it");
		expect(prepared.prompt?.text).toContain("toolResult read (call-1): ok");
		expect(prepared.prompt?.text).toContain("Current continuation request:");
	});

	test("bootstraps reconstructed history on a new agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		runtimeTestUtils.setOpenAgent(async () => fakeAgent("agent-new"));
		const prepared = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5" },
			context: historyThenContinue(),
			grantedTools: [], });
		expect(prepared.prompt?.text).toContain("target is important.ts");
		expect(prepared.prompt?.text).toContain("continue that edit");
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
		expect(second.prompt?.text).toContain("target is important.ts");
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
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId });
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
		expect(prepared.incremental).toBe(true);
		expect(prepared.prompt?.text).toBe("second");
		expect(prepared.prompt?.text).not.toContain("Previous OMP conversation");
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
		expect(prepared.prompt?.text).toContain("first");
		expect(prepared.prompt?.text).toContain("second");
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
		expect(recovered.prompt?.text).toContain("target is important.ts");
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
