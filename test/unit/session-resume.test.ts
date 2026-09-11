import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE } from "../../src/constants.ts";
import {
	EMPTY_BRANCH_HASH,
	foldResumeHandle,
	getMatchingResumeHandle,
	hashBranchStep,
	parseResumeEntryData,
	persistResumeHandle,
	flushResumeHandleNow,
	registerCursorSessionResume,
	__testUtils as resumeTestUtils,
	type ResumeEntryData,
	type ResumeSessionEntry,
} from "../../src/session-resume.ts";
import { ownerForContext, withCursorSessionOwner, __testUtils as scopeTestUtils } from "../../src/session-scope.ts";

function message(id: string, parentId: string | null, role: "user" | "assistant"): ResumeSessionEntry {
	return { type: "message", id, parentId, message: { role } };
}

function resume(id: string, parentId: string | null, data: ResumeEntryData): ResumeSessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		customType: CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
		data,
	};
}

function validData(overrides: Partial<ResumeEntryData> = {}): ResumeEntryData {
	return {
		version: 2,
		runtime: "local",
		agentId: "agent-local-1",
		scopeKey: "/tmp/session.jsonl",
		sessionFile: "/tmp/session.jsonl",
		sessionId: "sess-1",
		cwd: "/tmp/project",
		poolKey: "main",
		branchPathHash: EMPTY_BRANCH_HASH,
		compactionGeneration: 0,
		sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 1 },
		createdAt: "2026-09-08T00:00:00.000Z",
		storeIdentity: { version: 1, stateRoot: "/tmp/store" },
		state: "committed",
		agentInstanceId: "main",
		credentialScopeId: "cred-1",
		...overrides,
	};
}

const scope = {
	scopeKey: "/tmp/session.jsonl",
	sessionFile: "/tmp/session.jsonl",
	sessionId: "sess-1",
	cwd: "/tmp/project",
};

describe("session resume fold", () => {
	test("a captured writer refuses to append after its host switches sessions", () => {
		scopeTestUtils.reset();
		const { appended, ctx } = registerResume();
		ctx.sessionManager.getSessionId = () => "different-session";
		expect(() => flushResumeHandleNow({
			agentId: "agent-local-1",
			poolKey: "main",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
			state: "in-flight",
			agentInstanceId: "main",
			cwd: "/tmp/project",
			credentialScopeId: "cred-1",
		})).toThrow(/session changed/);
		expect(appended).toEqual([]);
	});

	test("parses a v2 local resume entry", () => {
		expect(parseResumeEntryData(validData())?.agentId).toBe("agent-local-1");
		expect(parseResumeEntryData({ ...validData(), runtime: "cloud" })).toBeUndefined();
		expect(parseResumeEntryData({ ...validData(), agentId: "bc-cloud" })).toBeUndefined();
	});

	test("keeps a handle that matches the current branch hash and compaction generation", () => {
		const user = message("u1", null, "user");
		const data = validData({ branchPathHash: hashBranchStep(EMPTY_BRANCH_HASH, user) });
		const branch = [user, resume("r1", "u1", data)];
		const fold = foldResumeHandle(branch, scope);
		expect(fold.activeHandle?.agentId).toBe("agent-local-1");
		expect(fold.compactionGeneration).toBe(0);
	});

	test("assistant messages drop a spanning handle; compaction bumps generation", () => {
		const user = message("u1", null, "user");
		const afterUser = hashBranchStep(EMPTY_BRANCH_HASH, user);
		const data = validData({ branchPathHash: afterUser });
		const compacted: ResumeSessionEntry = { type: "compaction", id: "c1", parentId: "a1" };
		const branch = [user, resume("r1", "u1", data), message("a1", "r1", "assistant"), compacted];
		const fold = foldResumeHandle(branch, scope);
		expect(fold.activeHandle).toBeUndefined();
		expect(fold.compactionGeneration).toBe(1);
	});

	function registerResume(mode: "write" | "swallow" | "missing-file" = "write"): {
		appended: Array<{ type: string; data: unknown }>;
		sessionFile: string;
		handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
		ctx: { cwd: string; sessionManager: Record<string, unknown> };
	} {
		const appended: Array<{ type: string; data: unknown }> = [];
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const sessionFile = join(mkdtempSync(join(tmpdir(), "omp-csr-resume-")), "session.jsonl");
		writeFileSync(sessionFile, "");
		scopeTestUtils.set("/tmp/project", mode === "missing-file" ? undefined : sessionFile, "sess-1");
		const branch = [message("u1", null, "user")];
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => (mode === "missing-file" ? undefined : sessionFile),
				getSessionId: () => "sess-1",
				getBranch: () => branch,
				getEntries: () => branch,
			},
		};
		const pi = {
			appendEntry(customType: string, data?: unknown) {
				appended.push({ type: customType, data });
				if (mode === "write") {
					const file = ctx.sessionManager.getSessionFile?.() as string | undefined;
					if (file) appendFileSync(file, `${JSON.stringify({ type: "custom", customType, data })}\n`);
				}
			},
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		};
		registerCursorSessionResume(pi as never);
		void handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		return { appended, sessionFile, handlers, ctx };
	}

	test("flushes a pending resume handle on turn_end", async () => {
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { appended, handlers, ctx } = registerResume();
		persistResumeHandle({
			agentId: "agent-local-1",
			poolKey: "main",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
			state: "committed",
			agentInstanceId: "main",
			cwd: "/tmp/project",
			credentialScopeId: "cred-1",
		});
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(appended).toHaveLength(1);
		expect(appended[0]?.type).toBe(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE);
		expect(parseResumeEntryData(appended[0]?.data)?.agentId).toBe("agent-local-1");
		expect(parseResumeEntryData(appended[0]?.data)?.state).toBe("committed");
		expect(parseResumeEntryData(appended[0]?.data)?.cwd).toBe(resolve("/tmp/project"));
	});

	test("session_switch rebinds resume writer for a new owner without session_start", async () => {
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { appended, handlers, ctx } = registerResume();
		const pending = {
			poolKey: "main",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			storeIdentity: { version: 1 as const, stateRoot: "/tmp/store" },
			agentInstanceId: "main",
			cwd: "/tmp/project",
			credentialScopeId: "cred-1",
		};
		persistResumeHandle({ ...pending, agentId: "agent-a", state: "committed" });
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(appended).toHaveLength(1);
		expect(parseResumeEntryData(appended[0]?.data)?.sessionId).toBe("sess-1");

		const fileB = join(mkdtempSync(join(tmpdir(), "omp-csr-resume-b-")), "session-b.jsonl");
		writeFileSync(fileB, "");
		const branchB = [message("u1", null, "user")];
		ctx.sessionManager.getSessionFile = () => fileB;
		ctx.sessionManager.getSessionId = () => "sess-b";
		ctx.sessionManager.getBranch = () => branchB;
		ctx.sessionManager.getEntries = () => branchB;
		// In-process /new emits session_switch without another session_start.
		await handlers.get("session_switch")?.[0]?.({ type: "session_switch", reason: "new" }, ctx);

		const ownerB = ownerForContext(ctx as never);
		withCursorSessionOwner(ownerB, () => {
			persistResumeHandle({ ...pending, agentId: "agent-b", state: "committed" });
		});
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(appended).toHaveLength(2);
		expect(parseResumeEntryData(appended[1]?.data)).toMatchObject({ sessionId: "sess-b", agentId: "agent-b", state: "committed" });

		withCursorSessionOwner(ownerB, () => {
			flushResumeHandleNow({ ...pending, agentId: "agent-b", state: "in-flight" });
		});
		expect(appended).toHaveLength(3);
		expect(parseResumeEntryData(appended[2]?.data)).toMatchObject({ sessionId: "sess-b", agentId: "agent-b", state: "in-flight" });
		expect(parseResumeEntryData(appended[0]?.data)?.sessionId).toBe("sess-1");
		expect(appended.slice(1).every((entry) => parseResumeEntryData(entry.data)?.sessionId === "sess-b")).toBe(true);
	});

	test("writes the agent's execution cwd instead of the session cwd", () => {
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { appended } = registerResume();
		flushResumeHandleNow({
			agentId: "agent-local-1",
			poolKey: "main",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
			state: "in-flight",
			agentInstanceId: "main",
			cwd: "/tmp/other",
			credentialScopeId: "cred-1",
		});
		expect(parseResumeEntryData(appended[0]?.data)?.cwd).toBe(resolve("/tmp/other"));
		expect(parseResumeEntryData(appended[0]?.data)?.cwd).not.toBe(resolve("/tmp/project"));
	});

	test("folds a handle whose execution cwd differs from the session cwd", () => {
		const user = message("u1", null, "user");
		const data = validData({
			branchPathHash: hashBranchStep(EMPTY_BRANCH_HASH, user),
			cwd: "/tmp/other",
		});
		const fold = foldResumeHandle([user, resume("r1", "u1", data)], scope);
		expect(fold.activeHandle?.agentId).toBe("agent-local-1");
		expect(fold.activeHandle?.cwd).toBe("/tmp/other");
	});

	test("flushResumeHandleNow appends in-flight before send and fails closed without appendEntry", () => {
		scopeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-without-writer");
		resumeTestUtils.reset();
		expect(() =>
			flushResumeHandleNow({
				agentId: "agent-local-1",
				poolKey: "main",
				sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
				storeIdentity: { version: 1, stateRoot: "/tmp/store" },
				state: "in-flight",
				agentInstanceId: "main",
				cwd: "/tmp/project",
				credentialScopeId: "cred-1",
			}),
		).toThrow(/appendEntry/);
		const { appended } = registerResume();
		flushResumeHandleNow({
			agentId: "agent-local-1",
			poolKey: "main",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
			state: "in-flight",
			agentInstanceId: "main",
			cwd: "/tmp/project",
			credentialScopeId: "cred-1",
		});
		expect(appended).toHaveLength(1);
		expect(parseResumeEntryData(appended[0]?.data)?.state).toBe("in-flight");
		expect(getMatchingResumeHandle("main", "cred-1")).toBeUndefined();
	});

	test("flushResumeHandleNow fails closed when appendEntry swallows a disk write", () => {
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume("swallow");
		expect(() =>
			flushResumeHandleNow({
				agentId: "agent-local-1",
				poolKey: "main",
				sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
				storeIdentity: { version: 1, stateRoot: "/tmp/store" },
				state: "in-flight",
				agentInstanceId: "main",
				cwd: "/tmp/project",
				credentialScopeId: "cred-1",
			}),
		).toThrow(/not persisted/);
		expect(resumeTestUtils.state.activeHandle).toBeUndefined();
	});

	test("flushResumeHandleNow fails closed when the session has no session file", () => {
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume("missing-file");
		expect(() =>
			flushResumeHandleNow({
				agentId: "agent-local-1",
				poolKey: "main",
				sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
				storeIdentity: { version: 1, stateRoot: "/tmp/store" },
				state: "in-flight",
				agentInstanceId: "main",
				cwd: "/tmp/project",
				credentialScopeId: "cred-1",
			}),
		).toThrow(/session file/);
	});

	test("keeps ExtensionAPI this when flushing so OMP runtime.appendEntry is reachable", () => {
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const appended: Array<{ type: string; data: unknown }> = [];
		const sessionFile = join(mkdtempSync(join(tmpdir(), "omp-csr-this-")), "session.jsonl");
		writeFileSync(sessionFile, "");
		scopeTestUtils.set("/tmp/project", sessionFile, "sess-1");
		class FakeExtensionApi {
			runtime = {
				appendEntry(customType: string, data?: unknown) {
					appended.push({ type: customType, data });
					appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`);
				},
			};
			appendEntry(customType: string, data?: unknown) {
				this.runtime.appendEntry(customType, data);
			}
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				if (event === "session_start") {
					handler(
						{ type: "session_start" },
						{
							cwd: "/tmp/project",
							sessionManager: {
								getSessionFile: () => sessionFile,
								getSessionId: () => "sess-1",
								getBranch: () => [],
								getEntries: () => [],
							},
						},
					);
				}
			}
		}
		registerCursorSessionResume(new FakeExtensionApi() as never);
		flushResumeHandleNow({
			agentId: "agent-local-1",
			poolKey: "main",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
			state: "in-flight",
			agentInstanceId: "main",
			cwd: "/tmp/project",
			credentialScopeId: "cred-1",
		});
		expect(appended).toHaveLength(1);
		expect(parseResumeEntryData(appended[0]?.data)?.state).toBe("in-flight");
	});

	test("rejects dirty and in-flight handles at the resume gate", () => {
		scopeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		resumeTestUtils.reset();
		resumeTestUtils.state.scopeKey = "/tmp/session.jsonl";
		resumeTestUtils.state.sessionFile = "/tmp/session.jsonl";
		resumeTestUtils.state.sessionId = "sess-1";
		resumeTestUtils.state.cwd = "/tmp/project";
		resumeTestUtils.state.activeHandle = validData({ state: "dirty" });
		expect(getMatchingResumeHandle("main", "cred-1")).toBeUndefined();
		resumeTestUtils.state.activeHandle = validData({ state: "in-flight" });
		expect(getMatchingResumeHandle("main", "cred-1")).toBeUndefined();
		resumeTestUtils.state.activeHandle = validData({ state: "committed" });
		expect(getMatchingResumeHandle("main", "cred-1")?.agentId).toBe("agent-local-1");
		expect(getMatchingResumeHandle("main", "cred-1", "/tmp/other")).toBeUndefined();
		expect(getMatchingResumeHandle("main", "cred-1", "/tmp/project")?.agentId).toBe("agent-local-1");
		expect(getMatchingResumeHandle("main", "other-cred")).toBeUndefined();
		resumeTestUtils.state.activeHandle = validData({ state: "committed", credentialScopeId: undefined });
		expect(getMatchingResumeHandle("main", "cred-1")).toBeUndefined();
	});

	test("a later in-flight record supersedes an older committed handle on the same lineage", () => {
		const user = message("u1", null, "user");
		const afterUser = hashBranchStep(EMPTY_BRANCH_HASH, user);
		const committed = validData({ branchPathHash: afterUser, state: "committed" });
		const inflight = validData({ branchPathHash: afterUser, state: "in-flight" });
		const r1 = resume("r1", "u1", committed);
		const r2 = resume("r2", "u1", inflight);
		const fold = foldResumeHandle([user, r1], scope, new Set(), [user, r1, r2]);
		expect(fold.activeHandle).toBeUndefined();
	});
});
