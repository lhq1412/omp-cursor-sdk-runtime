import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelListItem, Run, RunResult, SDKAgent, SDKCustomToolResult, SDKUserMessage, SendOptions } from "@cursor/sdk";
import { completeSimple } from "@oh-my-pi/pi-ai";
import {
	AgentRegistry,
	AuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
	createAgentSession,
	type AgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { ensureCursorModels, __testUtils as catalogTestUtils } from "../../src/catalog.ts";
import { CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import cursorPlugin from "../../src/index.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as controlsTestUtils } from "../../src/model-controls.ts";
import { __testUtils as resumeTestUtils } from "../../src/session-resume.ts";
import { __testUtils as runtimeTestUtils } from "../../src/session-runtime.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
import type { OpenAgentInput } from "../../src/sdk-session.ts";

const ITEMS: ModelListItem[] = [{ id: "composer-2.5", displayName: "Composer 2.5" }];

type ToolEvent = { toolCallId: string; toolName: string };
type RequestEvent = { cwd: string; sessionId: string; sessionFile: string | undefined };
type HostSdkToolResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
};
type ToolEndEvent = { toolCallId: string; toolName: string; result: unknown; isError: boolean };
type SpeculationHook = {
	execute(context: { toolCall: { id: string } }, signal: AbortSignal): Promise<unknown>;
};
type AgentToolWithSpeculation = {
	name: string;
	execute: (...args: never[]) => Promise<unknown>;
	speculation?: { finalized?: SpeculationHook };
};
interface CreateHostOptions {
	onToolStart?: (event: ToolEvent) => void;
	onToolEnd?: (event: ToolEndEvent) => void;
	settings?: Parameters<typeof Settings.isolated>[0];
	agentRegistry?: AgentRegistry;
	agentId?: string;
	agentDisplayName?: string;
	agentName?: string;
	taskDepth?: number;
	parentAgentId?: string;
	cwd?: string;
	enableEligibleSpeculation?: boolean;
}

interface HostFixture {
	root: string;
	cwd: string;
	session: AgentSession;
	authStorage: AuthStorage;
	requests: RequestEvent[];
	toolStarts: ToolEvent[];
	sessionId: string;
}

function hostResult(result: SDKCustomToolResult): HostSdkToolResult {
	if (!result || typeof result !== "object" || Array.isArray(result) || !("content" in result)) {
		throw new Error("Cursor SDK custom tool callback did not return host content");
	}
	return result as HostSdkToolResult;
}

function schemaProperties(tool: { inputSchema: unknown } | undefined, name: string): Record<string, unknown> {
	const schema = tool?.inputSchema;
	if (!schema || typeof schema !== "object" || Array.isArray(schema) || !("properties" in schema)) {
		throw new Error(`${name} was not advertised as an object schema`);
	}
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
		throw new Error(`${name} schema has no properties`);
	}
	return Object.fromEntries(Object.entries(properties));
}

function textOf(result: SDKCustomToolResult): string {
	return hostResult(result).content.map(block => block.type === "text" ? block.text ?? "" : "").join("\n");
}

function finished(result: string): RunResult {
	return { status: "finished", result } as RunResult;
}

function run(wait: () => Promise<RunResult>): Run {
	return {
		supports(capability: string) {
			return capability === "cancel";
		},
		async cancel() {},
		wait,
	} as unknown as Run;
}

function tool(session: AgentSession, name: string): AgentToolWithSpeculation {
	const found = session.agent.state.tools.find(candidate => candidate.name === name);
	if (!found) throw new Error(`OMP did not mount ${name}`);
	return found as unknown as AgentToolWithSpeculation;
}

function observeSpeculativeExecution(session: AgentSession, name: string, calls: string[]): void {
	const finalized = tool(session, name).speculation?.finalized;
	if (!finalized) throw new Error(`OMP did not expose finalized speculation for ${name}`);
	const execute = finalized.execute.bind(finalized);
	finalized.execute = async (context, signal) => {
		calls.push(context.toolCall.id);
		return execute(context, signal);
	};
}

function observeOrdinaryExecution(session: AgentSession, name: string, calls: string[]): void {
	const mounted = tool(session, name);
	const execute = mounted.execute.bind(mounted);
	mounted.execute = async (...args) => {
		calls.push(name);
		return execute(...args);
	};
}

async function createHost(label: string, toolNames: string[], options: CreateHostOptions = {}): Promise<HostFixture> {
	const root = mkdtempSync(join(tmpdir(), `omp-host-${label}-`));
	const cwd = options.cwd ?? join(root, "workspace");
	const agentDir = join(root, "agent");
	const sessionsDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"edit.mode": "replace",
		"retry.enabled": false,
		"tools.approvalMode": "yolo",
		"tools.speculativeExecution.enabled": true,
		"tools.speculativeExecution.maxInFlight": 2,
		...options.settings,
	});
	const authStorage = await AuthStorage.create(join(agentDir, "agent.db"));
	authStorage.setRuntimeApiKey(CURSOR_SDK_PROVIDER_ID, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), {
		settings,
		cacheDbPath: join(agentDir, "models.db"),
	});
	const registrationRuntime = new ExtensionRuntime();
	await loadExtensionFromFactory(cursorPlugin, cwd, new EventBus(), registrationRuntime, `cursor-host-${label}`);
	const registration = registrationRuntime.pendingProviderRegistrations.find(candidate => candidate.name === CURSOR_SDK_PROVIDER_ID);
	if (!registration) throw new Error("Cursor SDK plugin did not register its provider");
	modelRegistry.registerProvider(registration.name, registration.config, registration.sourceId);
	await modelRegistry.refreshRuntimeProviders();
	const model = modelRegistry.find(CURSOR_SDK_PROVIDER_ID, ITEMS[0]!.id);
	if (!model) throw new Error("OMP did not materialize the Cursor SDK model");
	const sessionManager = SessionManager.create(cwd, sessionsDir);
	await sessionManager.ensureOnDisk();
	const sessionId = sessionManager.getSessionId();
	const requests: RequestEvent[] = [];
	const toolStarts: ToolEvent[] = [];
	const observer: ExtensionFactory = pi => {
		pi.on("before_provider_request", (_event, ctx) => {
			requests.push({
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
			});
		});
		pi.on("tool_execution_start", event => {
			const observed = { toolCallId: event.toolCallId, toolName: event.toolName };
			toolStarts.push(observed);
			options.onToolStart?.(observed);
		});
		pi.on("tool_execution_end", event => {
			options.onToolEnd?.({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			});
		});
	};
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry,
		model,
		getApiKey: async () => "test-key",
		systemPrompt: "Exercise the installed OMP host loop.",
		sessionManager,
		settings,
		extensions: [cursorPlugin, observer],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		toolNames,
		restrictToolNames: false,
		autoApprove: true,
		agentRegistry: options.agentRegistry ?? new AgentRegistry(),
		agentId: options.agentId,
		agentDisplayName: options.agentDisplayName,
		agentName: options.agentName,
		taskDepth: options.taskDepth,
		parentAgentId: options.parentAgentId,
	});
	if (options.enableEligibleSpeculation) {
		// Public Agent configuration: remove the unrelated inline-edit transform so
		// pi-agent-core can admit finalized speculation for this focused scenario.
		session.agent.transformAssistantMessage = undefined;
	}
	await session.setActiveToolsByName(toolNames);
	await initializeExtensions(session, {
		reportSendError(_action, error) {
			throw error;
		},
		reportRuntimeError(error) {
			throw error.error;
		},
	});
	return { root, cwd, session, authStorage, requests, toolStarts, sessionId };
}

describe("OMP 18.2 host compatibility", () => {
	const fixtures: HostFixture[] = [];

	beforeEach(async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		controlsTestUtils.reset();
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setListModels(async () => ITEMS);
		catalogTestUtils.registerModelItems(ITEMS);
		await ensureCursorModels("test-key");
	});

	afterEach(async () => {
		for (const fixture of fixtures) {
			await fixture.session.extensionRunner?.emit({ type: "session_shutdown" });
			await fixture.session.dispose();
			fixture.authStorage.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
		fixtures.length = 0;
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		resumeTestUtils.reset();
		controlsTestUtils.reset();
		catalogTestUtils.resetCatalog();
	});

	test("stock host isolates concurrent parked reads and executes each SDK id once without unsafe speculation", async () => {
		const callbackResults = new Map<string, SDKCustomToolResult[]>();
		const openedCwds: string[] = [];
		let opened = 0;
		runtimeTestUtils.setOpenAgent(async (input: OpenAgentInput) => {
			const agentId = `agent-${++opened}`;
			openedCwds.push(input.cwd);
			return {
				agentId,
				async [Symbol.asyncDispose]() {},
				async send(_message: SDKUserMessage, options?: SendOptions) {
					const read = options?.local?.customTools?.read;
					if (!read) throw new Error("Cursor SDK fake did not receive OMP read");
					const first = read.execute({ path: "owned.txt" }, { toolCallId: "shared-sdk-read" });
					const duplicate = read.execute({ path: "owned.txt" }, { toolCallId: "shared-sdk-read" });
					return run(async () => {
						const results = await Promise.all([first, duplicate]);
						callbackResults.set(input.cwd, results);
						return finished(`read ${input.cwd}`);
					});
				},
			} as unknown as SDKAgent;
		});

		const a = await createHost("a", ["read"]);
		const b = await createHost("b", ["read"]);
		fixtures.push(a, b);
		writeFileSync(join(a.cwd, "owned.txt"), "owner A\n");
		writeFileSync(join(b.cwd, "owned.txt"), "owner B\n");
		const aSpeculative: string[] = [];
		const aOrdinary: string[] = [];
		const bOrdinary: string[] = [];
		const bSpeculative: string[] = [];
		observeSpeculativeExecution(a.session, "read", aSpeculative);
		observeOrdinaryExecution(a.session, "read", aOrdinary);
		observeOrdinaryExecution(b.session, "read", bOrdinary);
		observeSpeculativeExecution(b.session, "read", bSpeculative);

		await Promise.all([a.session.prompt("read the owned file"), b.session.prompt("read the owned file")]);
		await Promise.all([a.session.waitForIdle(), b.session.waitForIdle()]);
		if (openedCwds.length === 0) throw new Error("OMP did not dispatch either owner");

		expect(new Set(openedCwds)).toEqual(new Set([a.cwd, b.cwd]));
		expect(opened).toBe(2);
		for (const [fixture, expected, speculative] of [
			[a, "owner A", aSpeculative],
			[b, "owner B", bSpeculative],
		] as const) {
			const results = callbackResults.get(fixture.cwd);
			expect(results).toHaveLength(2);
			expect(textOf(results![0]!)).toContain(expected);
			expect(speculative.length + (fixture === a ? aOrdinary.length : bOrdinary.length)).toBe(1);
			expect(results![1]).toEqual(results![0]);
			expect(fixture.toolStarts).toEqual([{ toolCallId: expect.any(String), toolName: "read" }]);
			expect(fixture.requests).toHaveLength(2);
			expect(fixture.requests.every(request => request.cwd === fixture.cwd)).toBe(true);
			expect(fixture.requests.every(request => request.sessionId === fixture.sessionId)).toBe(true);
			expect(fixture.requests.every(request => request.sessionFile === fixture.session.sessionManager.getSessionFile())).toBe(true);
		}
	});

	test("eligible read speculation executes once while write, edit, and bash wait for host dispatch", async () => {
		const completed: SDKCustomToolResult[] = [];
		runtimeTestUtils.setOpenAgent(async (input: OpenAgentInput) => ({
			agentId: "side-effects-agent",
			async [Symbol.asyncDispose]() {},
			async send(_message: SDKUserMessage, options?: SendOptions) {
				const customTools = options?.local?.customTools;
				if (!customTools?.read || !customTools.write || !customTools.edit || !customTools.bash) {
					throw new Error("Cursor SDK fake did not receive the requested OMP tools");
				}
				const pending = [
					customTools.read.execute({ path: "source.txt" }, { toolCallId: "read-once" }),
					customTools.write.execute({ path: "written.txt", content: "written once\n" }, { toolCallId: "write-once" }),
					customTools.edit.execute({ path: "edited.txt", old_string: "before", new_string: "after" }, { toolCallId: "edit-once" }),
					customTools.bash.execute({ command: "printf shell-once >> shell.txt" }, { toolCallId: "bash-once" }),
				];
				return run(async () => {
					completed.push(...await Promise.all(pending));
					return finished(`completed ${input.cwd}`);
				});
			},
		}) as unknown as SDKAgent);

		let fixture!: HostFixture;
		let sideEffectsBeforeReadDispatch: [boolean, string, boolean] | undefined;
		fixture = await createHost("effects", ["read", "write", "edit", "bash"], {
			enableEligibleSpeculation: true,
			onToolStart(event) {
				if (event.toolName !== "read") return;
				sideEffectsBeforeReadDispatch = [
					existsSync(join(fixture.cwd, "written.txt")),
					readFileSync(join(fixture.cwd, "edited.txt"), "utf8"),
					existsSync(join(fixture.cwd, "shell.txt")),
				];
			},
		});
		fixtures.push(fixture);
		writeFileSync(join(fixture.cwd, "source.txt"), "source contents\n");
		writeFileSync(join(fixture.cwd, "edited.txt"), "before\n");
		const speculative: string[] = [];
		const ordinaryRead: string[] = [];
		const ordinaryEffects: string[] = [];
		observeOrdinaryExecution(fixture.session, "read", ordinaryRead);
		for (const name of ["write", "edit", "bash"]) observeOrdinaryExecution(fixture.session, name, ordinaryEffects);
		observeSpeculativeExecution(fixture.session, "read", speculative);
		for (const name of ["write", "edit", "bash"]) {
			expect(tool(fixture.session, name).speculation?.finalized).toBeUndefined();
		}

		await fixture.session.prompt("exercise all host tools");
		await fixture.session.waitForIdle();

		expect(speculative).toHaveLength(1);
		expect(sideEffectsBeforeReadDispatch).toEqual([false, "before\n", false]);
		expect(ordinaryRead).toEqual([]);
		expect(ordinaryEffects.sort()).toEqual(["bash", "edit", "write"]);
		expect(fixture.toolStarts.map(event => event.toolName).sort()).toEqual(["bash", "edit", "read", "write"]);
		expect(new Set(fixture.toolStarts.map(event => event.toolCallId)).size).toBe(4);
		expect(completed).toHaveLength(4);
		expect(completed.every(result => hostResult(result).isError !== true)).toBe(true);
		expect(readFileSync(join(fixture.cwd, "written.txt"), "utf8")).toBe("written once\n");
		expect(readFileSync(join(fixture.cwd, "edited.txt"), "utf8")).toBe("after\n");
		expect(readFileSync(join(fixture.cwd, "shell.txt"), "utf8")).toBe("shell-once");
	});

	test("abort clears the request owner and a later prompt binds a new SDK agent", async () => {
		const entered = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<RunResult>();
		const disposed = new Set<string>();
		let cancelCalls = 0;
		let opened = 0;
		runtimeTestUtils.setOpenAgent(async () => {
			const agentId = `abort-agent-${++opened}`;
			return {
				agentId,
				close() {
					disposed.add(agentId);
				},
				async [Symbol.asyncDispose]() {
					disposed.add(agentId);
				},
				async send() {
					if (agentId !== "abort-agent-1") return run(async () => finished("fresh binding"));
					return {
						supports(capability: string) {
							return capability === "cancel";
						},
						async cancel() {
							cancelCalls++;
							cancelled.resolve(finished("cancelled"));
						},
						wait() {
							entered.resolve();
							return cancelled.promise;
						},
					} as unknown as Run;
				},
			} as unknown as SDKAgent;
		});
		const fixture = await createHost("abort", []);
		fixtures.push(fixture);

		const pending = fixture.session.prompt("wait for abort");
		await entered.promise;
		await fixture.session.abort({ reason: "compat abort" });
		await pending;

		expect(cancelCalls).toBeGreaterThanOrEqual(1);
		expect(disposed).toContain("abort-agent-1");
		expect([...runtimeTestUtils.slots.values()].every(slot => slot.agent === undefined)).toBe(true);
		expect(fixture.requests).toHaveLength(1);
		await fixture.session.prompt("bind again");
		await fixture.session.waitForIdle();
		expect(opened).toBe(2);
		expect(fixture.requests).toHaveLength(2);
		expect([...runtimeTestUtils.slots.values()].map(slot => slot.agent?.agentId)).toEqual(["abort-agent-2"]);
	});

	test("automatic retry discards the failed binding and rebinds the same request owner", async () => {
		const opens: Array<{ agentId: string; savedAgentId: string | undefined }> = [];
		runtimeTestUtils.setOpenAgent(async (input: OpenAgentInput) => {
			const agentId = `retry-agent-${opens.length + 1}`;
			opens.push({ agentId, savedAgentId: input.savedAgentId });
			return {
				agentId,
				async [Symbol.asyncDispose]() {},
				async send() {
					if (agentId === "retry-agent-1") {
						return run(async () => ({
							status: "error",
							error: { code: "unavailable", message: "service unavailable" },
						}) as RunResult);
					}
					return run(async () => finished("retry recovered"));
				},
			} as unknown as SDKAgent;
		});
		const fixture = await createHost("retry", [], {
			settings: {
				"retry.enabled": true,
				"retry.maxRetries": 1,
				"retry.baseDelayMs": 0,
				"retry.maxDelayMs": 0,
				"retry.modelFallback": false,
			},
		});
		fixtures.push(fixture);

		await fixture.session.prompt("retry once");
		await fixture.session.waitForIdle();

		expect(opens).toEqual([
			{ agentId: "retry-agent-1", savedAgentId: undefined },
			{ agentId: "retry-agent-2", savedAgentId: undefined },
		]);
		expect(fixture.requests).toHaveLength(2);
		expect(fixture.requests.every(request => request.sessionId === fixture.sessionId)).toBe(true);
		expect([...runtimeTestUtils.slots.values()].map(slot => slot.agent?.agentId)).toEqual(["retry-agent-2"]);
	});

	test("a real subagent session binds its own owner and never borrows the main SDK agent", async () => {
		const registry = new AgentRegistry();
		const opens: Array<{ cwd: string; agentId: string; savedAgentId: string | undefined }> = [];
		runtimeTestUtils.setOpenAgent(async (input: OpenAgentInput) => {
			const agentId = `tree-agent-${opens.length + 1}`;
			opens.push({ cwd: input.cwd, agentId, savedAgentId: input.savedAgentId });
			return {
				agentId,
				async [Symbol.asyncDispose]() {},
				async send() {
					return run(async () => finished(agentId));
				},
			} as unknown as SDKAgent;
		});
		const main = await createHost("main", [], {
			agentRegistry: registry,
			agentId: "Main",
			agentDisplayName: "main",
			agentName: "main",
		});
		fixtures.push(main);
		await main.session.prompt("main request");
		await main.session.waitForIdle();
		const mainSlot = [...runtimeTestUtils.slots.values()].find(slot => slot.agent?.agentId === "tree-agent-1");
		if (!mainSlot) throw new Error("Main runtime binding was not committed");
		const mainSessionFile = main.session.sessionManager.getSessionFile();
		if (!mainSessionFile) throw new Error("Main session was not persisted");
		const mainJournal = readFileSync(mainSessionFile, "utf8");
		const child = await createHost("child", [], {
			agentRegistry: registry,
			agentId: "Child",
			agentDisplayName: "child",
			agentName: "sub",
			taskDepth: 1,
			parentAgentId: "Main",
			cwd: main.cwd,
		});
		fixtures.push(child);
		await child.session.prompt("child request");
		await child.session.waitForIdle();

		expect(opens).toEqual([
			{ cwd: main.cwd, agentId: "tree-agent-1", savedAgentId: undefined },
			{ cwd: child.cwd, agentId: "tree-agent-2", savedAgentId: undefined },
		]);
		expect(main.requests.every(request => request.sessionId === main.sessionId)).toBe(true);
		expect(child.requests.every(request => request.sessionId === child.sessionId)).toBe(true);
		expect(runtimeTestUtils.slots.get(mainSlot.key)).toBe(mainSlot);
		expect(mainSlot.agent?.agentId).toBe("tree-agent-1");
		expect(readFileSync(mainSessionFile, "utf8")).toBe(mainJournal);
		expect(child.sessionId).not.toBe(main.sessionId);
		expect(new Set([...runtimeTestUtils.slots.values()].map(slot => slot.agent?.agentId))).toEqual(
			new Set(["tree-agent-1", "tree-agent-2"]),
		);
	});

	test("public auxiliary completion intentionally bypasses request hooks without borrowing the main binding", async () => {
		const opens: Array<{ agentId: string; savedAgentId: string | undefined }> = [];
		const disposed = new Set<string>();
		runtimeTestUtils.setOpenAgent(async (input: OpenAgentInput) => {
			const agentId = `aux-agent-${opens.length + 1}`;
			opens.push({ agentId, savedAgentId: input.savedAgentId });
			return {
				agentId,
				close() {
					disposed.add(agentId);
				},
				async [Symbol.asyncDispose]() {
					disposed.add(agentId);
				},
				async send() {
					return run(async () => finished(agentId));
				},
			} as unknown as SDKAgent;
		});
		const main = await createHost("aux-main", []);
		fixtures.push(main);
		await main.session.prompt("main request");
		await main.session.waitForIdle();
		const mainSlot = [...runtimeTestUtils.slots.values()].find(slot => slot.agent?.agentId === "aux-agent-1");
		if (!mainSlot) throw new Error("Main runtime binding was not committed");
		const mainSessionFile = main.session.sessionManager.getSessionFile();
		if (!mainSessionFile) throw new Error("Main session was not persisted");
		const mainJournal = readFileSync(mainSessionFile, "utf8");
		const model = main.session.model;
		if (!model) throw new Error("Main session has no materialized model");

		const auxiliary = await completeSimple(model, {
			messages: [{ role: "user", content: "auxiliary title", timestamp: Date.now() }],
			tools: [],
		}, {
			apiKey: "test-key",
			cwd: main.cwd,
			sessionId: main.sessionId,
		});
		await new Promise<void>(resolve => setImmediate(resolve));

		expect(auxiliary.stopReason).toBe("stop");
		expect(opens).toEqual([
			{ agentId: "aux-agent-1", savedAgentId: undefined },
			{ agentId: "aux-agent-2", savedAgentId: undefined },
		]);
		expect(main.requests).toHaveLength(1);
		expect(disposed).toContain("aux-agent-2");
		expect(runtimeTestUtils.slots.get(mainSlot.key)).toBe(mainSlot);
		expect(mainSlot.agent?.agentId).toBe("aux-agent-1");
		expect(readFileSync(mainSessionFile, "utf8")).toBe(mainJournal);
	});

	test("installed grants keep disabled find out and pass live bash, edit, read, and eval contracts", async () => {
		const captured: SDKCustomToolResult[] = [];
		const ends: ToolEndEvent[] = [];
		let customTools: NonNullable<NonNullable<SendOptions["local"]>["customTools"]> | undefined;
		runtimeTestUtils.setOpenAgent(async () => ({
			agentId: "contract-agent",
			async [Symbol.asyncDispose]() {},
			async send(_message: SDKUserMessage, options?: SendOptions) {
				customTools = options?.local?.customTools;
				if (!customTools?.read || !customTools.bash || !customTools.edit || !customTools.eval || !customTools.glob) {
					throw new Error("Cursor SDK fake did not receive the installed OMP grant");
				}
				if (customTools.find) throw new Error("disabled find was granted");
				const pending = [
					customTools.read.execute({ path: "wide.txt" }, { toolCallId: "read-wide" }),
					customTools.read.execute({ path: "dot.png" }, { toolCallId: "read-image" }),
					customTools.bash.execute({ command: "printf kept" }, { toolCallId: "bash-kept" }),
				];
				return run(async () => {
					captured.push(...await Promise.all(pending));
					return finished("contracts");
				});
			},
		}) as unknown as SDKAgent);

		const fixture = await createHost("contracts", ["read", "bash", "edit", "eval", "find", "glob"], {
			settings: {
				"edit.mode": "patch",
				"eval.js": false,
				"tools.speculativeExecution.enabled": false,
			},
			onToolEnd(event) {
				ends.push(event);
			},
		});
		fixtures.push(fixture);
		writeFileSync(join(fixture.cwd, "wide.txt"), Array.from({ length: 3001 }, (_, index) =>
			index === 0 ? "HEAD-MARKER" : index === 3000 ? "TAIL-MARKER" : "line",
		).join("\n"));
		writeFileSync(join(fixture.cwd, "dot.png"), Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		));

		await fixture.session.prompt("exercise installed tool contracts");
		await fixture.session.waitForIdle();
		if (!customTools) throw new Error("OMP did not send custom tools");
		expect(Object.keys(customTools).sort()).toEqual(fixture.session.agent.state.tools.map(item => item.name).sort());
		expect(customTools.find).toBeUndefined();
		expect(schemaProperties(customTools.bash, "bash")).not.toHaveProperty("env");
		expect(textOf(captured[2]!)).toContain("kept");

		const editTool = fixture.session.agent.state.tools.find(item => item.name === "edit");
		if (!editTool) throw new Error("OMP did not mount edit");
		expect(customTools.edit.description).toContain(editTool.description);
		const editExample = editTool.examples?.[0];
		if (!editExample || typeof editExample.caption !== "string") throw new Error("patch edit did not expose an example");
		expect(customTools.edit.description).toContain(editExample.caption);
		const editProperties = schemaProperties(customTools.edit, "edit");
		expect(editProperties).toHaveProperty("path");
		expect(editProperties).toHaveProperty("edits");
		expect(editProperties).not.toHaveProperty("old_string");

		const evalTool = fixture.session.agent.state.tools.find(item => item.name === "eval");
		if (!evalTool?.description) throw new Error("OMP did not mount eval guidance");
		expect(customTools.eval.description).toContain(evalTool.description);
		const evalCaption = evalTool.examples?.[0]?.caption;
		if (typeof evalCaption === "string") expect(customTools.eval.description).toContain(evalCaption);
		const evalProperties = schemaProperties(customTools.eval, "eval");
		expect(evalProperties).toHaveProperty("language");
		expect(evalProperties).toHaveProperty("code");

		expect(textOf(captured[0]!)).toContain("HEAD-MARKER");
		expect(textOf(captured[0]!)).not.toContain("TAIL-MARKER");
		const wide = ends.find(event => event.toolName === "read" && JSON.stringify(event.result).includes("HEAD-MARKER"));
		if (!wide || !wide.result || typeof wide.result !== "object" || !("details" in wide.result)) {
			throw new Error("wide read did not finish with details");
		}
		const details = wide.result.details;
		if (!details || typeof details !== "object" || Array.isArray(details) || !("truncation" in details)) {
			throw new Error("wide read did not report truncation stats");
		}
		const truncation = details.truncation;
		if (!truncation || typeof truncation !== "object" || Array.isArray(truncation)) {
			throw new Error("wide read truncation stats are unreadable");
		}
		expect(truncation).not.toHaveProperty("content");

		const image = hostResult(captured[1]!).content.find(block => block.type === "image");
		expect(typeof image?.data).toBe("string");
		expect(image?.data).not.toBe("");
		expect(image?.mimeType).toMatch(/^image\//);
	});

	test("enabled find stays distinct from glob and does not widen the grant", async () => {
		let customTools: NonNullable<NonNullable<SendOptions["local"]>["customTools"]> | undefined;
		runtimeTestUtils.setOpenAgent(async () => ({
			agentId: "find-agent",
			async [Symbol.asyncDispose]() {},
			async send(_message: SDKUserMessage, options?: SendOptions) {
				customTools = options?.local?.customTools;
				return run(async () => finished("find"));
			},
		}) as unknown as SDKAgent);

		const fixture = await createHost("find-on", ["find", "glob", "read"], {
			settings: { "find.enabled": true },
		});
		fixtures.push(fixture);
		await fixture.session.prompt("list find");
		await fixture.session.waitForIdle();
		if (!customTools?.find || !customTools.glob) throw new Error("enabled find or glob was not granted");
		expect(Object.keys(customTools).sort()).toEqual(fixture.session.agent.state.tools.map(item => item.name).sort());
		expect(customTools.find).not.toBe(customTools.glob);
		const findProperties = schemaProperties(customTools.find, "find");
		expect(findProperties).toHaveProperty("query");
		expect(findProperties).toHaveProperty("grep_keywords");
		const findTool = fixture.session.agent.state.tools.find(item => item.name === "find");
		if (!findTool?.description) throw new Error("OMP did not mount find");
		expect(customTools.find.description).toContain(findTool.description);
	});
});
