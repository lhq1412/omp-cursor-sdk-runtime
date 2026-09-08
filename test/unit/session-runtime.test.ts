import { describe, expect, test } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import type { SDKAgent } from "@cursor/sdk";
import { credentialScopeId } from "../../src/auth.ts";
import { computeContextFingerprint } from "../../src/context.ts";
import { prepareTurn, agentConfigMismatch, __testUtils as runtimeTestUtils } from "../../src/session-runtime.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
import { registerCursorSessionResume, __testUtils as resumeTestUtils } from "../../src/session-resume.ts";

function fakeAgent(id: string): SDKAgent {
	return {
		agentId: id,
		close() {},
		async [Symbol.asyncDispose]() {},
	} as unknown as SDKAgent;
}

function userContext(text: string): Context {
	return { messages: [{ role: "user", content: text, timestamp: 1 } as Context["messages"][number]] };
}

function registerResume(): Array<{ type: string; data: unknown }> {
	const appended: Array<{ type: string; data: unknown }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const branch: Array<{ type: string; id: string; parentId: string | null; message?: { role: string } }> = [];
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
	void handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
	return appended;
}

describe("session runtime", () => {
	test("refuses parked tool results when no in-memory live run exists", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		const context = {
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
		await expect(
			prepareTurn({
				cwd: "/tmp/project",
				agentInstanceId: "main",
				apiKey: "test-key",
				modelId: "composer-2.5",
				context,
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
		const context = {
			messages: [
				{ role: "user", content: "target is important.ts", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
				{ role: "user", content: "continue that edit", timestamp: 3 },
			],
		} as Context;
		const prepared = await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelId: "composer-2.5",
			context,
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
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		const appended = registerResume();
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
		await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelId: "composer-2.5",
			context: secondContext,
			grantedTools: [],
		});
		expect(opens).toBe(1);
		expect(appended.some((entry) => (entry.data as { state?: string }).state === "in-flight")).toBe(true);
	});

	test("creates a new agent when cwd or credentials change", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		registerResume();
		const ids: string[] = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			const id = `agent-${ids.length + 1}`;
			ids.push(`${id}:${input.cwd}`);
			return fakeAgent(id);
		});
		const first = await prepareTurn({
			cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "key-a",
			modelId: "composer-2.5",
			context: userContext("first"),
			grantedTools: [],
		});
		first.slot.bindingState = "committed";
		liveRunTestUtils.clear();
		expect(agentConfigMismatch(first.slot, "/tmp/other", credentialScopeId("key-a"))).toBe(true);
		expect(agentConfigMismatch(first.slot, first.slot.cwd, credentialScopeId("key-b"))).toBe(true);
		await prepareTurn({
			cwd: "/tmp/other",
			agentInstanceId: "main",
			apiKey: "key-b",
			modelId: "composer-2.5",
			context: userContext("second"),
			grantedTools: [],
		});
		expect(ids).toHaveLength(2);
		expect(ids[1]).toContain("/tmp/other");
	});
});
