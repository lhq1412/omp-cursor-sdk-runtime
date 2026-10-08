import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Context } from "@oh-my-pi/pi-ai";
import type { SDKAgent } from "@cursor/sdk";
import type { GrantedTool, HostToolResult } from "../../src/contracts.ts";
import { credentialScopeId } from "../../src/auth.ts";
import { computeContextFingerprint, locatorFor } from "../../src/context.ts";
import { CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE } from "../../src/constants.ts";
import {
	prepareTurn,
	commitTurn,
	beginAgentSend,
	finishTurnFailed,
	finishLiveKeepAgent,
	disposeRuntimeForScope,
	invalidateRuntime,
	agentConfigMismatch,
	warmLocalExecutor,
	__testUtils as runtimeTestUtils,
	type PreparedTurn,
} from "../../src/session-runtime.ts";
import { getLiveRun, liveRunKey, __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { registerCursorSessionLifecycle } from "../../src/session-lifecycle.ts";
import { buildAgentOptions } from "../../src/sdk-session.ts";
import { __testUtils as scopeTestUtils, getCursorSessionOwner, ownerForContext, ownerForRequest, registerCursorSessionScope, withCursorSessionOwner } from "../../src/session-scope.ts";
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

	test("keeps the agent when granted tool name, description, or schema changes", async () => {
		async function sendNext(nextTools: GrantedTool[]) {
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
			const second = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: secondContext, grantedTools: nextTools,
			});
			return { opens, second };
		}

		const renamed = await sendNext([{ name: "grep", description: "read files", inputSchema: { type: "object" } }]);
		expect(renamed.opens).toEqual([{ customTools: ["read"], toolNameMap: [["read", "read"]] }]);
		expect(Object.keys(renamed.second.customTools)).toEqual(["grep"]);
		expect(renamed.second.customTools.grep?.description).toBe("read files");
		expect(renamed.second.incremental).toBe(true);
		expect(renamed.second.prompt?.text).toBe("second");

		const redescribed = await sendNext([{ name: "read", description: "read files carefully", inputSchema: { type: "object" } }]);
		expect(redescribed.opens).toHaveLength(1);
		expect(redescribed.second.customTools.read?.description).toBe("read files carefully");

		const nextSchema = { type: "object", properties: { path: { type: "string" } } };
		const reschemaed = await sendNext([{ name: "read", description: "read files", inputSchema: nextSchema }]);
		expect(reschemaed.opens).toHaveLength(1);
		expect(reschemaed.second.customTools.read?.inputSchema).toMatchObject(nextSchema);

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

	test("a stale tool-contract fingerprint reuses the agent and does not resend consumed input", async () => {
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
		expect(opens).toEqual([]);
		expect(histories).toEqual([]);
		expect(identical.incremental).toBe(true);
		expect(identical.slot.agent?.agentId).toBe("agent-1");
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
		expect(opens).toEqual([]);
		expect(histories).toEqual([]);
		expect(next.incremental).toBe(true);
		expect(next.slot.agent?.agentId).toBe("agent-1");
		expect(next.prompt?.text).toContain("New request");
		expect(next.prompt?.text).not.toContain(committed);
	});

	test("a persisted stale tool fingerprint still resumes the old agent without resending consumed input", async () => {
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
		expect(opens).toEqual([{ savedAgentId: "agent-old" }]);
		expect(histories).toEqual([undefined]);
		expect(prepared.incremental).toBe(true);
		expect(prepared.prompt?.text).toContain("Continue the conversation from where it left off.");
		expect(prepared.prompt?.text).not.toContain(committed);
	});

	test("a persisted stale tool fingerprint resumes across restart without resending consumed input", async () => {
		const tools = [{ name: "read", description: "read files", inputSchema: { type: "object" } }];
		const committed = "Already executed request";
		const same = userContext(committed);
		const appended = {
			messages: [
				same.messages[0]!,
				{ role: "user", content: "New request", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;

		async function prepareOnce(openImpl: Parameters<typeof runtimeTestUtils.setOpenAgent>[0], context: Context) {
			const opens: Array<{ savedAgentId?: string }> = [];
			const histories: Array<Context["messages"] | undefined> = [];
			runtimeTestUtils.setOpenAgent(async (input) => {
				opens.push({ savedAgentId: input.savedAgentId });
				histories.push(input.bootstrapHistory);
				return openImpl(input);
			});
			const prepared = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context, grantedTools: tools,
			});
			return { prepared, opens, histories };
		}

		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { sessionFile, handlers, ctx } = registerResume();
		seedCommittedHandle(sessionFile, same, "agent-old", tools);
		resumeTestUtils.state.activeHandle!.toolContractFingerprint = "omp-custom-tools-v1-stale";

		const first = await prepareOnce(async (input) => fakeAgent(input.savedAgentId ?? "missing"), same);
		expect(first.opens).toEqual([{ savedAgentId: "agent-old" }]);
		expect(first.histories).toEqual([undefined]);
		expect(first.prepared.prompt?.text).toContain("Continue the conversation from where it left off.");
		expect(first.prepared.prompt?.text).not.toContain(committed);
		commitTurn(first.prepared.slot, same, first.prepared.incremental);
		await handlers.get("turn_end")?.[0]?.({}, ctx);
		expect(resumeTestUtils.state.activeHandle?.state).toBe("committed");
		expect(resumeTestUtils.state.activeHandle?.agentId).toBe("agent-old");

		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		const afterRestart = await prepareOnce(async (input) => fakeAgent(input.savedAgentId ?? "missing"), same);
		expect(afterRestart.opens).toEqual([{ savedAgentId: "agent-old" }]);
		expect(afterRestart.histories).toEqual([undefined]);
		expect(afterRestart.prepared.prompt?.text).toContain("Continue the conversation from where it left off.");
		expect(afterRestart.prepared.prompt?.text).not.toContain(committed);
		commitTurn(afterRestart.prepared.slot, same, afterRestart.prepared.incremental);
		await handlers.get("turn_end")?.[0]?.({}, ctx);

		const withAppend = await prepareOnce(async () => fakeAgent("agent-append"), appended);
		expect(withAppend.opens).toEqual([]);
		expect(withAppend.prepared.incremental).toBe(true);
		expect(withAppend.prepared.slot.agent?.agentId).toBe("agent-old");
		expect(withAppend.prepared.prompt?.text).toContain("New request");
		expect(withAppend.prepared.prompt?.text).not.toContain(committed);
	});

	test("a stale tool fingerprint on a memory-only agent does not reopen or resend consumed input", async () => {
		const tools = [{ name: "read", description: "read files", inputSchema: { type: "object" } }];
		const committed = "Already executed request";
		const same = userContext(committed);
		const appended = {
			messages: [
				same.messages[0]!,
				{ role: "user", content: "New request", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;

		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		// Ephemeral owner: no persistent journal, same as explicit host bridge without OMP owner.
		const owner = ownerForRequest("memory-only-bridge", "/tmp/project");
		expect(owner.persistent).toBe(false);

		await withCursorSessionOwner(owner, async () => {
			expect(resumeTestUtils.state.activeHandle).toBeUndefined();
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
			first.slot.createCwd = "/tmp/project";
			first.slot.credentialScopeId = credentialScopeId("test-key");
			first.slot.toolContractFingerprint = "omp-custom-tools-v1-stale";
			liveRunTestUtils.clear();
			opens.length = 0;
			histories.length = 0;
			expect(resumeTestUtils.state.activeHandle).toBeUndefined();

			const continued = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: same, grantedTools: tools,
			});
			expect(opens).toEqual([]);
			expect(continued.slot.agent?.agentId).toBe(first.slot.agent?.agentId);
			expect(continued.prompt?.text).toContain("Continue the conversation from where it left off.");
			expect(continued.prompt?.text).not.toContain(committed);

			continued.slot.bindingState = "committed";
			continued.slot.sendState = {
				bootstrapped: true,
				contextFingerprint: computeContextFingerprint(same),
				incrementalSendCount: 0,
			};
			continued.slot.createCwd = "/tmp/project";
			continued.slot.credentialScopeId = credentialScopeId("test-key");
			continued.slot.toolContractFingerprint = "omp-custom-tools-v1-stale-again";
			const withAppend = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: appended, grantedTools: tools,
			});
			expect(opens).toEqual([]);
			expect(withAppend.slot.agent?.agentId).toBe(first.slot.agent?.agentId);
			expect(withAppend.prompt?.text).toContain("New request");
			expect(withAppend.prompt?.text).not.toContain(committed);
		});
	});

	test("a stale tool fingerprint reuses the agent; a send-started failure still dirties", async () => {
		const tools = [{ name: "read", description: "read files", inputSchema: { type: "object" } }];
		const committed = "Already executed request";
		const same = userContext(committed);
		const appended = {
			messages: [
				same.messages[0]!,
				{ role: "user", content: "New request", timestamp: 2 } as Context["messages"][number],
			],
		} as Context;

		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const owner = ownerForRequest("pre-send-cancel", "/tmp/project");
		expect(owner.persistent).toBe(false);

		await withCursorSessionOwner(owner, async () => {
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
			first.slot.createCwd = "/tmp/project";
			first.slot.credentialScopeId = credentialScopeId("test-key");
			first.slot.toolContractFingerprint = "omp-custom-tools-v1-stale";
			liveRunTestUtils.clear();
			opens.length = 0;
			histories.length = 0;

			const prepared = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: same, grantedTools: tools,
			});
			expect(opens).toEqual([]);
			expect(prepared.slot.preSendConsumption).toBeUndefined();
			expect(prepared.slot.sendStarted).toBe(false);
			expect(prepared.slot.agent?.agentId).toBe(first.slot.agent?.agentId);
			expect(prepared.prompt?.text).toContain("Continue the conversation from where it left off.");
			expect(prepared.prompt?.text).not.toContain(committed);

			beginAgentSend(prepared.slot);
			expect(prepared.slot.sendStarted).toBe(true);
			await finishTurnFailed(prepared.slot, "send failed");
			expect(prepared.slot.agent).toBeUndefined();
			expect(prepared.slot.sendState.bootstrapped).toBe(false);
			expect(prepared.slot.preSendConsumption).toBeUndefined();

			liveRunTestUtils.clear();
			opens.length = 0;
			histories.length = 0;
			const afterDirty = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: same, grantedTools: tools,
			});
			expect(opens).toEqual([{ savedAgentId: undefined }]);
			expect(afterDirty.prompt?.text).toContain(committed);
			expect(afterDirty.prompt?.text).not.toContain("Continue the conversation from where it left off.");

			afterDirty.slot.bindingState = "committed";
			afterDirty.slot.sendState = {
				bootstrapped: true,
				contextFingerprint: computeContextFingerprint(same),
				incrementalSendCount: 0,
			};
			afterDirty.slot.createCwd = "/tmp/project";
			afterDirty.slot.credentialScopeId = credentialScopeId("test-key");
			afterDirty.slot.toolContractFingerprint = "omp-custom-tools-v1-stale-again";
			liveRunTestUtils.clear();
			opens.length = 0;
			histories.length = 0;

			const reused = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: same, grantedTools: tools,
			});
			expect(opens).toEqual([]);
			expect(reused.slot.agent?.agentId).toBe(afterDirty.slot.agent?.agentId);
			expect(reused.prompt?.text).toContain("Continue the conversation from where it left off.");
			expect(reused.prompt?.text).not.toContain(committed);

			reused.slot.bindingState = "committed";
			reused.slot.sendState = {
				bootstrapped: true,
				contextFingerprint: computeContextFingerprint(same),
				incrementalSendCount: 0,
			};
			reused.slot.createCwd = "/tmp/project";
			reused.slot.credentialScopeId = credentialScopeId("test-key");
			reused.slot.toolContractFingerprint = "omp-custom-tools-v1-stale-again";
			const withAppend = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: appended, grantedTools: tools,
			});
			expect(opens).toEqual([]);
			expect(withAppend.slot.agent?.agentId).toBe(afterDirty.slot.agent?.agentId);
			expect(withAppend.prompt?.text).toContain("New request");
			expect(withAppend.prompt?.text).not.toContain(committed);
		});
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


	test("resumes the same agent when only the tool description or schema changes", async () => {
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
			expect(changed.opens).toEqual([{ savedAgentId: "agent-old" }]);
			expect(changed.histories).toEqual([undefined]);
			expect(changed.prepared.incremental).toBe(true);
			expect(changed.prepared.prompt?.text).toBe("new-request-after-resume");
			expect(changed.prepared.customTools.read?.description).toBe(nextTools[0]!.description);
			expect(changed.prepared.customTools.read?.inputSchema).toEqual(nextTools[0]!.inputSchema);
			expect(changed.host.calls).toEqual([]);
		}
	});

	test("keeps one agent across tool catalog changes including an empty grant", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		const opens: string[] = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push(input.savedAgentId ?? "created");
			return fakeAgent("agent-stable");
		});
		const tool = (description: string): GrantedTool[] => [{
			name: "read",
			description,
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
		}];
		const steps = ["one", "two", "three", "four"];
		const grants = [tool("A"), tool("B"), [], tool("A")];
		const prepared: PreparedTurn[] = [];
		for (let index = 0; index < steps.length; index += 1) {
			const turnContext = {
				messages: steps.slice(0, index + 1).map((text, timestamp) => ({ role: "user", content: text, timestamp: timestamp + 1 })),
			} as Context;
			const turn = await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: turnContext, grantedTools: grants[index]!,
			});
			prepared.push(turn);
			commitTurn(turn.slot, turnContext, index > 0);
		}
		expect(opens).toEqual(["created"]);
		expect(prepared[1]?.incremental).toBe(true);
		expect(prepared[1]?.customTools.read?.description).toBe("B");
		expect(prepared[2]?.customTools).toEqual({});
		expect(prepared[3]?.customTools.read?.description).toBe("A");
		expect(prepared[3]?.slot.agent?.agentId).toBe("agent-stable");
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

	test("tool results followed by developer context bootstrap continue-only and do not resume the parked run", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		const histories: Array<Context["messages"] | undefined> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			histories.push(input.bootstrapHistory);
			return fakeAgent(`agent-${histories.length}`);
		});
		const tools = granted("read");
		const first = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "key-a",
			modelSelection: { id: "composer-2.5" }, context: userContext("first"), grantedTools: tools,
		});
		const parked = Promise.withResolvers<HostToolResult>();
		const rejection = parked.promise.catch((error: unknown) => error);
		first.live.parked.push({
			name: "read",
			args: { path: "a.ts" },
			sdkToolCallId: "sdk-call-1",
			ompToolCallId: "call-1",
			yielded: true,
			resolve: parked.resolve,
			reject: parked.reject,
		});
		const passive = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }], timestamp: 2 },
				{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 },
				{ role: "developer", content: [{ type: "text", text: "additional context from the tool" }], timestamp: 4 },
			],
		} as Context;
		const prepared = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "key-a",
			modelSelection: { id: "composer-2.5" }, context: passive, grantedTools: tools,
		});
		expect(prepared.continuing).toBe(false);
		expect(prepared.incremental).toBe(false);
		expect(prepared.prompt?.text).toContain("Continue the conversation from where it left off.");
		expect(prepared.prompt?.text).not.toContain("additional context from the tool");
		expect(prepared.prompt?.text).not.toContain("file contents");
		expect(JSON.stringify(histories.at(-1))).toContain("additional context from the tool");
		expect(JSON.stringify(histories.at(-1))).toContain("file contents");
		expect(await rejection).toBeInstanceOf(Error);
		expect(getLiveRun(first.slot.key)).not.toBe(first.live);
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

	test("resumes the same agent with mcp when an empty grant becomes non-empty", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		const opens: Array<{ savedAgentId?: string; tools: string[]; mcp: boolean }> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push({
				savedAgentId: input.savedAgentId,
				tools: Object.keys(input.customTools),
				mcp: (buildAgentOptions(input).tools ?? []).includes("mcp"),
			});
			return fakeAgent(input.savedAgentId ?? "agent-empty");
		});
		const firstContext = userContext("first");
		const first = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: firstContext, grantedTools: [],
		});
		commitTurn(first.slot, firstContext, first.incremental);
		const secondContext = {
			messages: [...firstContext.messages, { role: "user", content: "read it", timestamp: 2 }],
		} as Context;
		const second = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: secondContext, grantedTools: granted("read"),
		});
		expect(opens).toEqual([
			{ savedAgentId: undefined, tools: [], mcp: false },
			{ savedAgentId: "agent-empty", tools: ["read"], mcp: true },
		]);
		expect(second.incremental).toBe(true);
		expect(second.prompt?.text).toContain("read it");
		expect(second.slot.agent?.agentId).toBe("agent-empty");
	});

	test("a late result of the previous call does not cancel the passive rebuild", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		registerResume();
		let nextAgent = 0;
		runtimeTestUtils.setOpenAgent(async (input) => fakeAgent(input.savedAgentId ?? `agent-${++nextAgent}`));
		const tools = granted("read");
		const first = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "key-a",
			modelSelection: { id: "composer-2.5" }, context: userContext("first"), grantedTools: tools,
		});
		seedParkedRead(first);
		const developer = { role: "developer", content: [{ type: "text", text: "additional context from the tool" }], timestamp: 4 };
		const passive = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }], timestamp: 2 },
				{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 },
				developer,
			],
		} as Context;
		const rebuilt = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "key-a",
			modelSelection: { id: "composer-2.5" }, context: passive, grantedTools: tools,
		});
		expect(rebuilt.live.requestLocator).toEqual(locatorFor(developer));
		rebuilt.live.parked.push({
			name: "read",
			args: { path: "b.ts" },
			sdkToolCallId: "sdk-call-b",
			ompToolCallId: "call-b",
			yielded: true,
			resolve() {},
			reject() {},
		});
		const late = {
			messages: [
				passive.messages[0],
				passive.messages[1],
				{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "late" }], isError: false, timestamp: 5 },
			],
		} as Context;
		await expect(prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "key-a",
			modelSelection: { id: "composer-2.5" }, context: late, grantedTools: tools,
		})).rejects.toThrow(/do not match/);
		expect(getLiveRun(rebuilt.slot.key)).toBe(rebuilt.live);
		expect(rebuilt.live.cancelled).toBe(false);
		expect(rebuilt.slot.agent?.agentId).toBe("agent-2");
		expect(rebuilt.slot.bindingState).not.toBe("dirty");
	});

	test("a rollover in-flight record does not resume the already advanced agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const { handlers, ctx, branch, sessionFile } = registerResume();
		const committed = {
			version: 5,
			runtime: "local",
			agentId: "agent-advanced",
			scopeKey: "/tmp/original.jsonl",
			sessionFile: "/tmp/original.jsonl",
			sessionId: "sess-1",
			cwd: "/tmp/project",
			poolKey: "main",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			sendState: { bootstrapped: true, contextFingerprint: "fp", incrementalSendCount: 1 },
			createdAt: "2026-09-08T00:00:00.000Z",
			storeIdentity: { version: 1, stateRoot: "/tmp/store" },
			state: "committed",
			agentInstanceId: "main",
			credentialScopeId: credentialScopeId("test-key"),
			persistenceId: "write-old",
			toolContractFingerprint: buildToolContract([]).fingerprint,
		};
		const inflight = {
			...committed,
			scopeKey: "/tmp/rolled.jsonl",
			sessionFile: "/tmp/rolled.jsonl",
			state: "in-flight",
			sendState: { bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 },
			persistenceId: "write-new",
		};
		branch.push({
			type: "custom",
			id: "r1",
			parentId: null,
			customType: CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
			data: committed,
		});
		ctx.sessionManager.getEntries = () => [
			...branch,
			{
				type: "custom",
				id: "r2",
				parentId: "r1",
				customType: CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE,
				data: inflight,
			},
		];
		await handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start" }, ctx);
		const opens: Array<string | undefined> = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			opens.push(input.savedAgentId);
			return fakeAgent(input.savedAgentId ?? "agent-fresh");
		});
		const prepared = await prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: userContext("back on the old branch"), grantedTools: [],
		});
		expect(sessionFile).not.toBe("");
		expect(opens).toEqual([undefined]);
		expect(prepared.incremental).toBe(false);
		expect(prepared.slot.agent?.agentId).toBe("agent-fresh");
	});
});

function scopeEventBus(): { fire(event: string, ctx: ExtensionContext): Promise<void> } {
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const pi = {
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as Pick<ExtensionAPI, "on">;
	registerCursorSessionLifecycle(pi);
	registerCursorSessionScope(pi);
	return {
		async fire(event, ctx) {
			for (const handler of handlers.get(event) ?? []) await handler(event as never, ctx);
		},
	};
}

describe("session scope runtime ownership", () => {
	function disposableAgent(id: string, disposed: string[]): SDKAgent {
		return {
			agentId: id,
			close() {},
			async [Symbol.asyncDispose]() { disposed.push(id); },
			send() { throw new Error("send() should not run in prepareTurn tests"); },
		} as unknown as SDKAgent;
	}

	test("shutting down the old file does not dispose the rolled owner's agent", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const disposed: string[] = [];
		let next = 0;
		runtimeTestUtils.setOpenAgent(async () => disposableAgent(`agent-${++next}`, disposed));
		const events = scopeEventBus();
		let file = "/tmp/original.jsonl";
		const managerA = {
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => file, getSessionId: () => "sess-roll" },
		} as ExtensionContext;
		await events.fire("before_provider_request", managerA);
		const ownerA = ownerForContext(managerA);
		await withCursorSessionOwner(ownerA, () => prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: userContext("live"), grantedTools: [],
		}));
		file = "/tmp/rolled.jsonl";
		await events.fire("before_provider_request", managerA);
		expect(ownerA.scopeKey).toBe("/tmp/rolled.jsonl");
		expect([...runtimeTestUtils.slots.values()].some((slot) => slot.owner === ownerA && slot.scopeKey === "/tmp/rolled.jsonl" && slot.agent?.agentId === "agent-1")).toBe(true);
		const managerB = {
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => "/tmp/original.jsonl", getSessionId: () => "sess-other" },
		} as ExtensionContext;
		await events.fire("before_provider_request", managerB);
		expect(ownerForContext(managerB).scopeKey).toBe("/tmp/original.jsonl");
		expect(ownerForContext(managerB)).not.toBe(ownerA);
		await events.fire("session_shutdown", managerB);
		expect(disposed).toEqual([]);
		expect([...runtimeTestUtils.slots.values()].some((slot) => slot.owner === ownerA && slot.agent?.agentId === "agent-1")).toBe(true);
		scopeTestUtils.reset();
	});

	test("promoting a nonwriter moves its agent and executor so shutdown can release them", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const disposed: string[] = [];
		let next = 0;
		runtimeTestUtils.setOpenAgent(async () => disposableAgent(`agent-${++next}`, disposed));
		const events = scopeEventBus();
		const file = "/tmp/shared.jsonl";
		const managerA = {
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => file, getSessionId: () => "sess" },
		} as ExtensionContext;
		const managerB = {
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => file, getSessionId: () => "sess" },
		} as ExtensionContext;
		await events.fire("before_provider_request", managerA);
		const ownerA = ownerForContext(managerA);
		await withCursorSessionOwner(ownerA, () => prepareTurn({
			modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
			modelSelection: { id: "composer-2.5" }, context: userContext("writer"), grantedTools: [],
		}));
		await events.fire("before_provider_request", managerB);
		const ownerB = ownerForContext(managerB);
		expect(ownerB.writer).toBe(false);
		const ephemeral = ownerB.scopeKey;
		expect(ephemeral).not.toBe(file);
		await withCursorSessionOwner(ownerB, async () => {
			warmLocalExecutor("/tmp/project", "test-key", "composer-2.5");
			await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: userContext("nonwriter"), grantedTools: [],
			});
		});
		expect(runtimeTestUtils.executorLeases.has(ephemeral)).toBe(true);
		await events.fire("session_shutdown", managerA);
		expect(disposed).toEqual(["agent-1"]);
		await events.fire("before_provider_request", managerB);
		expect(ownerB.writer).toBe(true);
		expect(ownerB.scopeKey).toBe(file);
		expect([...runtimeTestUtils.slots.values()].some((slot) => slot.scopeKey === ephemeral)).toBe(false);
		expect(runtimeTestUtils.executorLeases.has(ephemeral)).toBe(false);
		expect(runtimeTestUtils.executorLeases.has(file)).toBe(true);
		expect([...runtimeTestUtils.slots.values()].some((slot) => slot.owner === ownerB && slot.scopeKey === file && slot.agent?.agentId === "agent-2")).toBe(true);
		await events.fire("session_shutdown", managerB);
		expect(disposed).toEqual(["agent-1", "agent-2"]);
		expect([...runtimeTestUtils.slots.values()].some((slot) => slot.owner === ownerB)).toBe(false);
		expect(runtimeTestUtils.executorLeases.size).toBe(0);
		scopeTestUtils.reset();
	});

	test("a failed target lease isolates the demoted owner's runtime from the old file", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		const disposed: string[] = [];
		let next = 0;
		runtimeTestUtils.setOpenAgent(async () => disposableAgent(`agent-${++next}`, disposed));
		const events = scopeEventBus();
		const original = "/tmp/original.jsonl";
		const taken = "/tmp/taken.jsonl";
		let fileA = original;
		const managerHolder = {
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => taken, getSessionId: () => "sess-holder" },
		} as ExtensionContext;
		const managerA = {
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => fileA, getSessionId: () => "sess-a" },
		} as ExtensionContext;
		await events.fire("before_provider_request", managerHolder);
		expect(ownerForContext(managerHolder).writer).toBe(true);
		await events.fire("before_provider_request", managerA);
		const ownerA = ownerForContext(managerA);
		expect(ownerA.writer).toBe(true);
		expect(ownerA.scopeKey).toBe(original);
		await withCursorSessionOwner(ownerA, async () => {
			warmLocalExecutor("/tmp/project", "test-key", "composer-2.5");
			await prepareTurn({
				modelLimits, cwd: "/tmp/project", agentInstanceId: "main", apiKey: "test-key",
				modelSelection: { id: "composer-2.5" }, context: userContext("live"), grantedTools: [],
			});
		});
		fileA = taken;
		await events.fire("before_provider_request", managerA);
		expect(ownerA.writer).toBe(false);
		expect(ownerA.sessionFile).toBe(taken);
		expect(ownerA.scopeKey).not.toBe(original);
		expect(ownerA.scopeKey).not.toBe(taken);
		expect(ownerA.scopeKey.startsWith(scopeTestUtils.EPHEMERAL_SESSION_SCOPE_PREFIX)).toBe(true);
		const isolated = ownerA.scopeKey;
		expect([...runtimeTestUtils.slots.values()].some((slot) => slot.owner === ownerA && slot.scopeKey === isolated && slot.agent?.agentId === "agent-1")).toBe(true);
		expect([...runtimeTestUtils.slots.values()].some((slot) => slot.scopeKey === original)).toBe(false);
		expect(getLiveRun(liveRunKey(original, "main"))).toBeUndefined();
		expect(getLiveRun(liveRunKey(isolated, "main"))?.cancelled).toBe(false);
		expect(runtimeTestUtils.executorLeases.has(original)).toBe(false);
		expect(runtimeTestUtils.executorLeases.has(isolated)).toBe(true);
		const managerNext = {
			cwd: "/tmp/project",
			sessionManager: { getSessionFile: () => original, getSessionId: () => "sess-next" },
		} as ExtensionContext;
		await events.fire("before_provider_request", managerNext);
		expect(ownerForContext(managerNext).writer).toBe(true);
		expect(ownerForContext(managerNext).scopeKey).toBe(original);
		await events.fire("session_shutdown", managerNext);
		expect(disposed).toEqual([]);
		expect([...runtimeTestUtils.slots.values()].some((slot) => slot.owner === ownerA && slot.agent?.agentId === "agent-1")).toBe(true);
		expect(getLiveRun(liveRunKey(isolated, "main"))?.cancelled).toBe(false);
		expect(runtimeTestUtils.executorLeases.has(isolated)).toBe(true);
		scopeTestUtils.reset();
	});
});
