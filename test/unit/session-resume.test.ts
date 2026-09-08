import { describe, expect, test } from "bun:test";
import { CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE } from "../../src/constants.ts";
import {
	EMPTY_BRANCH_HASH,
	foldResumeHandle,
	hashBranchStep,
	parseResumeEntryData,
	persistResumeHandle,
	registerCursorSessionResume,
	__testUtils as resumeTestUtils,
	type ResumeEntryData,
	type ResumeSessionEntry,
} from "../../src/session-resume.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";

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

	test("flushes a pending resume handle on turn_end", async () => {
		scopeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		resumeTestUtils.reset();
		const appended: Array<{ type: string; data: unknown }> = [];
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const branch = [message("u1", null, "user")];
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "/tmp/session.jsonl",
				getSessionId: () => "sess-1",
				getBranch: () => branch,
				getEntries: () => branch,
			},
		};
		const pi = {
			appendEntry(customType: string, data?: unknown) {
				appended.push({ type: customType, data });
			},
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		};
		registerCursorSessionResume(pi as never);
		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		persistResumeHandle({
			agentId: "agent-local-1",
			poolKey: "main",
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 0 },
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
			state: "committed",
			agentInstanceId: "main",
		});
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		expect(appended).toHaveLength(1);
		expect(appended[0]?.type).toBe(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE);
		expect(parseResumeEntryData(appended[0]?.data)?.agentId).toBe("agent-local-1");
		expect(parseResumeEntryData(appended[0]?.data)?.state).toBe("committed");
	});
});
