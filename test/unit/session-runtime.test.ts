import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import type { SDKAgent } from "@cursor/sdk";
import { credentialScopeId } from "../../src/auth.ts";
import { computeContextFingerprint } from "../../src/context.ts";
import { prepareTurn, agentConfigMismatch, __testUtils as runtimeTestUtils } from "../../src/session-runtime.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
import { registerCursorSessionResume, __testUtils as resumeTestUtils } from "../../src/session-resume.ts";

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
} {
	const appended: Array<{ type: string; data: unknown }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sessionFile = join(mkdtempSync(join(tmpdir(), "omp-csr-")), "session.jsonl");
	writeFileSync(sessionFile, "");
	scopeTestUtils.set("/tmp/project", sessionFile, "sess-1");
	const branch: Array<{ type: string; id: string; parentId: string | null; message?: { role: string } }> = [];
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
	return { appended, sessionFile };
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
	test("refuses parked tool results when no in-memory live run exists", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		await expect(
			prepareTurn({
				cwd: "/tmp/project",
				agentInstanceId: "main",
				apiKey: "test-key",
				modelId: "composer-2.5",
				context: toolResultContext(),
				grantedTools: [],
			}),
		).rejects.toThrow(/restarted/);
	});

	test("bootstraps reconstructed history on a new agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		runtimeTestUtils.setOpenAgent(async () => fakeAgent("agent-new"));
		const prepared = await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelId: "composer-2.5",
			context: historyThenContinue(),
			grantedTools: [],
		});
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
		const first = await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelId: "composer-2.5",
			context: firstContext,
			grantedTools: [],
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
		const second = await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelId: "composer-2.5",
			context: secondContext,
			grantedTools: [],
		});
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
		registerResume();
		const opens: Array<{ savedAgentId?: string; cwd: string }> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId, cwd: input.cwd });
			return fakeAgent(`agent-${opens.length}`);
		});
		const context = historyThenContinue();
		const first = await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "key-a",
			modelId: "composer-2.5",
			context,
			grantedTools: [],
		});
		first.slot.bindingState = "committed";
		first.slot.sendState = {
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(context),
			incrementalSendCount: 0,
		};
		liveRunTestUtils.clear();
		expect(agentConfigMismatch(first.slot, "/tmp/other", credentialScopeId("key-a"))).toBe(true);
		expect(agentConfigMismatch(first.slot, first.slot.cwd, credentialScopeId("key-b"))).toBe(true);
		const second = await prepareTurn({
			cwd: "/tmp/other",
			agentInstanceId: "main",
			apiKey: "key-b",
			modelId: "composer-2.5",
			context,
			grantedTools: [],
		});
		expect(opens).toHaveLength(2);
		expect(opens[1]?.savedAgentId).toBeUndefined();
		expect(opens[1]?.cwd).toContain("/tmp/other");
		expect(second.incremental).toBe(false);
		expect(second.prompt?.text).toContain("target is important.ts");
		expect(second.prompt?.text).toContain("continue that edit");
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
		const prepared = await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelId: "composer-2.5",
			context: secondContext,
			grantedTools: [],
		});
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
		const prepared = await prepareTurn({
			cwd: "/tmp/other",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelId: "composer-2.5",
			context: secondContext,
			grantedTools: [],
		});
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
		await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "key-a",
			modelId: "composer-2.5",
			context: userContext("first"),
			grantedTools: [],
		});
		await expect(
			prepareTurn({
				cwd: "/tmp/other",
				agentInstanceId: "main",
				apiKey: "key-b",
				modelId: "composer-2.5",
				context: toolResultContext(),
				grantedTools: [],
			}),
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
		const first = await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelId: "composer-2.5",
			context: firstContext,
			grantedTools: [],
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
		await expect(
			prepareTurn({
				cwd: "/tmp/project",
				agentInstanceId: "main",
				apiKey: "test-key",
				modelId: "composer-2.5",
				context: secondContext,
				grantedTools: [],
			}),
		).rejects.toThrow(/not persisted/);
		expect(opens).toBe(1);
		expect(sends).toEqual([]);
	});
});
