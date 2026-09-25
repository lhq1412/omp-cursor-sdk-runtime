import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import type { SDKAgent } from "@cursor/sdk";
import type { GrantedTool, HostToolResult } from "../../src/contracts.ts";
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
import { getLiveRun, __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils, getCursorSessionOwner, ownerForRequest, withCursorSessionOwner } from "../../src/session-scope.ts";
import { parseResumeEntryData, registerCursorSessionResume, __testUtils as resumeTestUtils } from "../../src/session-resume.ts";
import { buildToolContract } from "../../src/tools.ts";
import { createFakeHost } from "../helpers/fake-host.ts";

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

function granted(...names: string[]): GrantedTool[] {
	return names.map((name) => ({ name, description: name, inputSchema: { type: "object" } }));
}
function seedParkedRead(prepared: PreparedTurn): void {
	prepared.live.parked.push({
		name: "read",
		args: { path: "a.ts" },
		sdkToolCallId: "sdk-call-1",
		ompToolCallId: "call-1",
		yielded: true,
		resolve() {},
		reject() {},
	});
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

function seedCommittedHandle(sessionFile: string, context: Context, agentId = "agent-old", grantedTools: GrantedTool[] = []): void {
	resumeTestUtils.state.activeHandle = {
		version: 5,
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
		persistenceId: "test-write",
		toolContractFingerprint: buildToolContract(grantedTools).fingerprint,
	};
}

function oldContextFingerprints(ctx: Context): string[] {
	const current = JSON.parse(computeContextFingerprint(ctx)) as { format: string; systemHash: string };
	return [
		JSON.stringify({ ...current, formatVersion: 2 }),
		JSON.stringify({
			format: current.format,
			systemHash: current.systemHash,
			messageHashes: ctx.messages.map((message, index) =>
				new Bun.CryptoHasher("sha256").update(`${index}:${message.role}:${JSON.stringify(message)}`).digest("hex").slice(0, 16),
			),
		}),
	];
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

	test("reopens the agent when granted tool name, description, or schema changes", async () => {
		async function reopenOn(nextTools: GrantedTool[]) {
			runtimeTestUtils.clear();
			liveRunTestUtils.clear();
			scopeTestUtils.reset();
			resumeTestUtils.reset();
			registerResume();
			const opens: Array<{ customTools: string[]; toolNameMap: Array<[string, string]> }> = [];
			runtimeTestUtils.setOpenAgent(async (input) => {
				opens.push({
					customTools: Object.keys(input.customTools),
					toolNameMap: input.toolNameMap ? [...input.toolNameMap.entries()] : [],
				});
				return fakeAgent(`agent-${opens.length}`);
			});
			const firstContext = userContext("first");
			const firstTools = [{ name: "read", description: "read files", inputSchema: { type: "object" } }];
			const first = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: firstContext, grantedTools: firstTools,
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
				modelSelection: { id: "composer-2.5" }, context: secondContext, grantedTools: nextTools,
			});
			return opens;
		}

		const renamed = await reopenOn([{ name: "grep", description: "read files", inputSchema: { type: "object" } }]);
		expect(renamed).toHaveLength(2);
		expect(renamed[0]).toEqual({ customTools: ["read"], toolNameMap: [["read", "read"]] });
		expect(renamed[1]).toEqual({ customTools: ["grep"], toolNameMap: [["grep", "grep"]] });

		const redescribed = await reopenOn([{ name: "read", description: "read files carefully", inputSchema: { type: "object" } }]);
		expect(redescribed).toHaveLength(2);

		const reschemaed = await reopenOn([{ name: "read", description: "read files", inputSchema: { type: "object", properties: { path: { type: "string" } } } }]);
		expect(reschemaed).toHaveLength(2);

		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		let opens = 0;
		runtimeTestUtils.setOpenAgent(async () => fakeAgent(`agent-${++opens}`));
		const firstContext = userContext("first");
		const tools = [{ name: "read", description: "read files", inputSchema: { type: "object" } }];
		const first = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: firstContext, grantedTools: tools,
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
		const reused = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: secondContext, grantedTools: tools,
		});
		expect(opens).toBe(1);
		expect(reused.incremental).toBe(true);
		expect(reused.prompt?.text).toBe("second");
	});

	test("tool-contract fingerprint change rebuilds without resending consumed input", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		const tools = [{ name: "read", description: "read files", inputSchema: { type: "object" } }];
		const committed = "Already executed request";
		const same = {
			messages: [{ role: "user", content: committed, timestamp: 1 } as Context["messages"][number]],
		} as Context;
		const appended = {
			messages: [
				same.messages[0]!,
				{ role: "user", content: "New request", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;
		const opens: Array<{ savedAgentId?: string }> = [];
		const histories: Array<Context["messages"] | undefined> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId });
			histories.push(input.bootstrapHistory);
			return fakeAgent(`agent-${opens.length}`);
		});
		const first = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: same, grantedTools: tools,
		});
		first.slot.bindingState = "committed";
		first.slot.sendState = {
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(same),
			incrementalSendCount: 0,
		};
		// Simulate an older guidance/fingerprint generation while keeping the same grants.
		first.slot.toolContractFingerprint = "omp-custom-tools-v1-stale";
		liveRunTestUtils.clear();
		opens.length = 0;
		histories.length = 0;

		const identical = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: same, grantedTools: tools,
		});
		expect(opens).toEqual([{ savedAgentId: undefined }]);
		expect(histories[0]).toEqual(same.messages);
		expect(identical.incremental).toBe(false);
		expect(identical.prompt?.text).toContain("Continue the conversation from where it left off.");
		expect(identical.prompt?.text).not.toContain(committed);

		identical.slot.bindingState = "committed";
		identical.slot.sendState = {
			bootstrapped: true,
			contextFingerprint: computeContextFingerprint(same),
			incrementalSendCount: 0,
		};
		identical.slot.toolContractFingerprint = "omp-custom-tools-v1-stale-again";
		liveRunTestUtils.clear();
		opens.length = 0;
		histories.length = 0;

		const next = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: appended, grantedTools: tools,
		});
		expect(opens).toEqual([{ savedAgentId: undefined }]);
		expect(histories[0]).toEqual(same.messages);
		expect(next.prompt?.text).toContain("New request");
		expect(next.prompt?.text).not.toContain(committed);
	});

	test("persisted tool fingerprint mismatch keeps consumption and does not resume the old agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { sessionFile } = registerResume();
		const tools = [{ name: "read", description: "read files", inputSchema: { type: "object" } }];
		const committed = "Already executed request";
		const same = userContext(committed);
		seedCommittedHandle(sessionFile, same, "agent-old", tools);
		resumeTestUtils.state.activeHandle!.toolContractFingerprint = "omp-custom-tools-v1-stale";
		const opens: Array<{ savedAgentId?: string }> = [];
		const histories: Array<Context["messages"] | undefined> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({ savedAgentId: input.savedAgentId });
			histories.push(input.bootstrapHistory);
			return fakeAgent("agent-new");
		});
		const prepared = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: same, grantedTools: tools,
		});
		expect(opens).toEqual([{ savedAgentId: undefined }]);
		expect(histories).toEqual([same.messages]);
		expect(prepared.prompt?.text).toContain("Continue the conversation from where it left off.");
		expect(prepared.prompt?.text).not.toContain(committed);
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

	test("resumes a mature matching committed handle incrementally without re-sending history", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { sessionFile } = registerResume();
		const firstContext = userContext("first");
		seedCommittedHandle(sessionFile, firstContext);
		resumeTestUtils.state.activeHandle!.sendState.incrementalSendCount = 20_000;
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

	test("persisted v2 and legacy handles rebuild without resending consumed input", async () => {
		const systemPrompt = "keep-system-policy";
		const committed = "Already executed request";
		const same = {
			systemPrompt,
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "Prior answer" }], timestamp: 1, completedAt: 2 },
				{ role: "user", content: committed, timestamp: 3 },
			],
		} as Context;
		const appended = {
			systemPrompt,
			messages: [...same.messages, { role: "developer", content: "New request", timestamp: 4 }],
		} as Context;
		async function openFrom(fingerprint: string, context: Context) {
			runtimeTestUtils.clear();
			liveRunTestUtils.clear();
			scopeTestUtils.reset();
			resumeTestUtils.reset();
			const { sessionFile } = registerResume();
			seedCommittedHandle(sessionFile, same);
			resumeTestUtils.state.activeHandle!.sendState.contextFingerprint = fingerprint;
			resumeTestUtils.state.activeHandle!.sendState.incrementalSendCount = 20_000;
			const opens: Array<{ savedAgentId?: string }> = [];
			const histories: Array<Context["messages"] | undefined> = [];
			runtimeTestUtils.setOpenAgent(async (input) => {
				opens.push({ savedAgentId: input.savedAgentId });
				histories.push(input.bootstrapHistory);
				return fakeAgent("agent-new");
			});
			const prepared = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context, grantedTools: [],
			});
			return { opens, histories, prepared };
		}
		for (const fingerprint of oldContextFingerprints(same)) {
			const identical = await openFrom(fingerprint, same);
			expect(identical.opens).toEqual([{ savedAgentId: undefined }]);
			expect(identical.histories).toEqual([same.messages]);
			expect(identical.prepared.incremental).toBe(false);
			expect(identical.prepared.prompt?.text).toContain(systemPrompt);
			expect(identical.prepared.prompt?.text).not.toContain(committed);
			expect(identical.prepared.prompt?.text).not.toContain("Prior answer");
			const next = await openFrom(fingerprint, appended);
			expect(next.opens).toEqual([{ savedAgentId: undefined }]);
			expect(next.histories).toEqual([same.messages]);
			expect(next.prepared.incremental).toBe(false);
			expect(next.prepared.prompt?.text).toEndWith("New request");
			expect(next.prepared.prompt?.text).not.toContain(committed);
		}
	});


	test("resumes a matching persisted tool contract and bootstraps history when description or schema changes", async () => {
		const readTool = { name: "read", description: "read files", inputSchema: { type: "object", properties: { path: { type: "string" } } } };
		const firstContext = userContext("already-executed-request");
		const secondContext = {
			messages: [
				firstContext.messages[0]!,
				{ role: "user", content: "new-request-after-resume", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;
		async function resumeWith(nextTools: GrantedTool[]) {
			runtimeTestUtils.clear();
			liveRunTestUtils.clear();
			scopeTestUtils.reset();
			resumeTestUtils.reset();
			const { sessionFile } = registerResume();
			seedCommittedHandle(sessionFile, firstContext, "agent-old", [readTool]);
			expect(JSON.parse(resumeTestUtils.state.activeHandle!.sendState.contextFingerprint).formatVersion).toBe(3);
			const host = createFakeHost({ cwd: "/tmp/project", tools: ["read"] });
			const opens: Array<{ savedAgentId?: string }> = [];
			const histories: Array<Context["messages"] | undefined> = [];
			runtimeTestUtils.setOpenAgent(async (input) => {
				opens.push({ savedAgentId: input.savedAgentId });
				histories.push(input.bootstrapHistory);
				return fakeAgent(input.savedAgentId ?? "agent-new");
			});
			const prepared = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: secondContext, grantedTools: nextTools, host,
			});
			return { prepared, opens, histories, host };
		}

		const matched = await resumeWith([readTool]);
		expect(matched.opens).toEqual([{ savedAgentId: "agent-old" }]);
		expect(matched.histories).toEqual([undefined]);
		expect(matched.prepared.incremental).toBe(true);
		expect(matched.prepared.continuing).toBe(false);
		expect(matched.prepared.prompt?.text).toBe("new-request-after-resume");
		const resumed = matched.prepared.customTools.read;
		expect(resumed?.description).toBe("read files");
		await expect(resumed!.execute({ path: "kept.ts" }, { toolCallId: "sdk-live-1" })).resolves.toMatchObject({
			isError: false,
			content: [{ type: "text", text: "ok:read" }],
		});
		expect(matched.host.calls).toEqual([{ name: "read", args: { path: "kept.ts" }, toolCallId: "sdk-live-1" }]);

		for (const nextTools of [
			[{ ...readTool, description: "read files carefully" }],
			[{ ...readTool, inputSchema: { type: "object", properties: { path: { type: "string" }, encoding: { type: "string" } } } }],
		]) {
			const changed = await resumeWith(nextTools);
			expect(changed.opens).toEqual([{ savedAgentId: undefined }]);
			expect(changed.histories).toEqual([firstContext.messages]);
			expect(changed.prepared.incremental).toBe(false);
			expect(changed.prepared.prompt?.text).toContain("new-request-after-resume");
			expect(changed.prepared.prompt?.text).not.toContain("already-executed-request");
			expect(changed.prepared.customTools.read?.description).toBe(nextTools[0]!.description);
			expect(changed.host.calls).toEqual([]);
		}
	});

	test("parked result mismatch stays fail closed beside a matching committed tool handle", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { sessionFile } = registerResume();
		const tools = [{ name: "read", description: "read files", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
		const context = userContext("already-executed-request");
		seedCommittedHandle(sessionFile, context, "agent-old", tools);
		const host = createFakeHost({ cwd: "/tmp/project", tools: ["read"] });
		const opened: Array<string | undefined> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opened.push(input.savedAgentId);
			return fakeAgent(input.savedAgentId ?? "agent-new");
		});
		const first = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context, grantedTools: tools, host,
		});
		const parked = Promise.withResolvers<HostToolResult>();
		const rejection = parked.promise.catch((error) => error);
		first.live.parked.push({
			name: "read",
			args: { path: "a.ts" },
			sdkToolCallId: "sdk-call-1",
			ompToolCallId: "call-1",
			yielded: true,
			resolve: parked.resolve,
			reject: parked.reject,
		});
		const mismatched: Context = {
			messages: [
				context.messages[0]!,
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "stale-call",
					toolName: "read",
					content: [{ type: "text", text: "stale" }],
					isError: false,
					timestamp: 3,
				},
			],
		} as Context;
		await expect(prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: mismatched, grantedTools: tools, host,
		})).rejects.toThrow(/do not match/);
		expect(opened).toEqual(["agent-old"]);
		expect(await rejection).toBeInstanceOf(Error);
		expect(getLiveRun(first.slot.key)).toBeUndefined();
		expect(first.live.cancelled).toBe(true);
		expect(first.slot.bindingState).toBe("dirty");
		expect(host.calls).toEqual([]);
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
		const first = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "key-a",
			modelSelection: { id: "composer-2.5" },
			context: userContext("first"),
			grantedTools: granted("read"), });
		seedParkedRead(first);
		await expect(
			prepareTurn({ modelLimits, cwd: "/tmp/other",
				agentInstanceId: "main",
				apiKey: "key-b",
				modelSelection: { id: "composer-2.5" },
				context: toolResultContext(),
				grantedTools: granted("read"), }),
		).rejects.toThrow(/cwd or credentials changed/);
		expect(opens).toEqual(["agent-1"]);
	});

	test("refuses parked continuation after the tool contract changes", async () => {
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
		const first = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "key-a",
			modelSelection: { id: "composer-2.5" }, context: userContext("first"),
			grantedTools: [{ name: "read", description: "read files", inputSchema: { type: "object" } }],
		});
		seedParkedRead(first);
		await expect(
			prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "key-a",
				modelSelection: { id: "composer-2.5" }, context: toolResultContext(),
				grantedTools: [{ name: "read", description: "read files carefully", inputSchema: { type: "object" } }],
			}),
		).rejects.toThrow(/tool contract changed/);
		expect(opens).toEqual(["agent-1"]);
	});

	test("mismatched parked results dirty and dispose the pending run without host execution", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		const host = createFakeHost({ cwd: "/tmp/project", tools: ["read"] });
		runtimeTestUtils.setOpenAgent(async () => fakeAgent("agent-1"));
		const first = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "key-a",
			modelSelection: { id: "composer-2.5" }, context: userContext("first"),
			grantedTools: granted("read"), host,
		});
		const parked = Promise.withResolvers<HostToolResult>();
		const rejection = parked.promise.catch((error) => error);
		first.live.parked.push({
			name: "read",
			args: { path: "a.ts" },
			sdkToolCallId: "sdk-call-1",
			ompToolCallId: "call-1",
			yielded: true,
			resolve: parked.resolve,
			reject: parked.reject,
		});
		const mismatched: Context = {
			messages: [
				userContext("first").messages[0]!,
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "stale-call",
					toolName: "read",
					content: [{ type: "text", text: "stale" }],
					isError: false,
					timestamp: 3,
				},
			],
		} as Context;
		await expect(prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "key-a",
			modelSelection: { id: "composer-2.5" }, context: mismatched,
			grantedTools: granted("read"), host,
		})).rejects.toThrow(/do not match/);
		expect(await rejection).toBeInstanceOf(Error);
		expect(getLiveRun(first.slot.key)).toBeUndefined();
		expect(first.live.cancelled).toBe(true);
		expect(first.slot.bindingState).toBe("dirty");
		expect(host.calls).toEqual([]);
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
		const first = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
			context: userContext("first"),
			grantedTools: granted("read"), });
		seedParkedRead(first);
		const next = await prepareTurn({ modelLimits, cwd: "/tmp/project",
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
			context: toolResultContext(),
			grantedTools: granted("read"), });
		expect(opened).toHaveLength(1);
		expect(next.continuing).toBe(true);
	});
});
