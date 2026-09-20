import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run, RunResult, SDKAgent, SendOptions } from "@cursor/sdk";
import type { Context, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";
import { credentialScopeId } from "../../src/auth.ts";
import { ensureCursorModels, __testUtils as catalogTestUtils } from "../../src/catalog.ts";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID, CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE } from "../../src/constants.ts";
import { HOST_BRIDGE_OPTION_KEY } from "../../src/host-option.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { createSharedToolExec } from "../../src/host-exec.ts";
import { streamCursorRuntime } from "../../src/provider.ts";
import {
	commitTurn,
	disposeRuntimeForScope,
	prepareTurn,
	__testUtils as runtimeTestUtils,
} from "../../src/session-runtime.ts";
import {
	getMatchingResumeHandle,
	hashBranchStep,
	parseResumeEntryData,
	registerCursorSessionResume,
	__testUtils as resumeTestUtils,
} from "../../src/session-resume.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
import { createFakeHost } from "./fake-host.ts";

const CUTPOINTS = [
	"in-flight",
	"send-entered",
	"tool-executed",
	"tool-result-persisted",
	"checkpoint-updated",
	"turn-committed",
	"host-binding-committed",
	"resume-committed",
] as const;
type Cutpoint = (typeof CUTPOINTS)[number];

const MODEL = {
	id: "composer-2.5",
	provider: CURSOR_SDK_PROVIDER_ID,
	api: CURSOR_SDK_API,
	contextWindow: 200_000,
	maxTokens: 8_192,
} as Model<Api>;
const READ: Tool = {
	name: "read",
	description: "read",
	parameters: { type: "object", properties: { path: { type: "string" } } },
} as Tool;
const MODEL_LIMITS = { contextWindow: 200_000, maxTokens: 8_192 };
const MODEL_SELECTION = { id: "composer-2.5" };

const mode = process.argv[2];
const root = process.argv[3];
const cutpoint = process.argv[4] as Cutpoint;
if (mode !== "write" && mode !== "recover") {
	console.error("usage: resume-crash-child write|recover <root> <cutpoint>");
	process.exit(2);
}
if (!root || !CUTPOINTS.includes(cutpoint)) {
	console.error(`invalid cutpoint: ${cutpoint}`);
	process.exit(2);
}

const sessionFile = join(root, "session.jsonl");
const countFile = join(root, "tool-count.json");
type BranchEntry = {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
	message?: unknown;
};
const branch: BranchEntry[] = [];
let seq = 0;
const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
const ctx = {
	cwd: root,
	sessionManager: {
		getSessionFile: () => sessionFile,
		getSessionId: () => "crash",
		getBranch: () => branch,
		getEntries: () => branch,
	},
};

function nextId(): string {
	seq += 1;
	return `e${seq}`;
}

function append(entry: BranchEntry): void {
	const last = branch.at(-1);
	entry.parentId = last?.id ?? null;
	branch.push(entry);
	appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
	if (!(entry.type === "custom" && entry.customType === CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE)) {
		resumeTestUtils.state.branchPathHash = hashBranchStep(resumeTestUtils.state.branchPathHash, entry as never);
	}
}

function appendMessage(message: unknown): void {
	append({ type: "message", id: nextId(), parentId: null, message });
}

function register(reset = false): void {
	if (reset) resumeTestUtils.reset();
	handlers.clear();
	const pi = {
		appendEntry(customType: string, data?: unknown) {
			append({
				type: "custom",
				id: nextId(),
				parentId: null,
				customType,
				data,
			});
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	registerCursorSessionResume(pi as never);
}

function loadBranch(): void {
	branch.length = 0;
	seq = 0;
	let text = "";
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as BranchEntry;
		branch.push(entry);
		const match = /^e(\d+)$/.exec(entry.id);
		if (match) seq = Math.max(seq, Number(match[1]));
	}
}

function bumpToolCount(): void {
	let count = 0;
	try {
		count = (JSON.parse(readFileSync(countFile, "utf8")) as { count: number }).count;
	} catch {
		count = 0;
	}
	writeFileSync(countFile, JSON.stringify({ count: count + 1 }));
}

function toolCount(): number {
	try {
		return (JSON.parse(readFileSync(countFile, "utf8")) as { count: number }).count;
	} catch {
		return 0;
	}
}
function userContext(text: string, tools: Tool[] = []): Context {
	return { messages: [{ role: "user", content: text, timestamp: 1 }], tools };
}

function secondContext(tools: Tool[] = []): Context {
	return {
		messages: [
			{ role: "user", content: "crash-turn-1", timestamp: 1 },
			{ role: "user", content: "crash-turn-2", timestamp: 2 },
		],
		tools,
	};
}

function reach(): Promise<never> {
	console.log(`REACHED ${cutpoint}`);
	return new Promise(() => undefined);
}

let currentSend: (options?: SendOptions) => Promise<Run> = async () => ({
	supports: () => false,
	wait: async () => ({ status: "finished" }) as RunResult,
} as unknown as Run);

function installAgent(): void {
	runtimeTestUtils.setOpenAgent(async (input) => {
		const agentId = input.savedAgentId ?? `agent-${cutpoint}`;
		return {
			agentId,
			close() {},
			async [Symbol.asyncDispose]() {},
			async send(_message: unknown, options?: SendOptions) {
				return currentSend(options);
			},
		} as unknown as SDKAgent;
	});
}

async function drain(context: Context, options: SimpleStreamOptions) {
	const events = [];
	for await (const event of streamCursorRuntime(MODEL, context, {
		...options,
		onPayload: scopeTestUtils.bindRequest,
	})) {
		events.push(event);
	}
	return events;
}

async function seed(): Promise<void> {
	writeFileSync(sessionFile, "");
	scopeTestUtils.set(root, sessionFile, "crash");
	register();
	await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
	catalogTestUtils.resetCatalog();
	catalogTestUtils.setListModels(async () => [{ id: "composer-2.5", displayName: "Composer 2.5" }]);
	await ensureCursorModels("test-key");
	installAgent();
	const context = userContext("crash-turn-1");
	appendMessage(context.messages[0]);
	const prepared = await prepareTurn({
		modelLimits: MODEL_LIMITS,
		cwd: root,
		agentInstanceId: "main",
		apiKey: "test-key",
		modelSelection: MODEL_SELECTION,
		context,
		grantedTools: [],
	});
	commitTurn(prepared.slot, context, prepared.incremental);
	await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
}

async function writeTurn(): Promise<void> {
	if (cutpoint === "in-flight") {
		await disposeRuntimeForScope();
		liveRunTestUtils.clear();
		resumeTestUtils.reset();
		loadBranch();
		scopeTestUtils.set(root, sessionFile, "crash");
		register();
		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		runtimeTestUtils.setOpenAgent(async () => reach());
		await prepareTurn({
			modelLimits: MODEL_LIMITS,
			cwd: root,
			agentInstanceId: "main",
			apiKey: "test-key",
			modelSelection: MODEL_SELECTION,
			context: secondContext(),
			grantedTools: [],
		});
		return;
	}

	const needsTool = cutpoint === "tool-executed" || cutpoint === "tool-result-persisted";
	const context = secondContext(needsTool ? [READ] : []);
	appendMessage(context.messages[1]);
	const host = createFakeHost({ cwd: root, sessionId: "crash", tools: needsTool ? ["read"] : [] });
	if (cutpoint === "turn-committed") {
		host.commitBinding = async () => reach();
	}
	if (cutpoint === "host-binding-committed") {
		host.commitBinding = async (binding) => {
			writeFileSync(join(root, "host-binding.json"), JSON.stringify({ agentId: binding.sdkAgentId }));
			host.bindings.push(binding);
		};
	}

	currentSend = async (options) => {
		if (cutpoint === "send-entered") return reach();
		if (needsTool) {
			const tool = options?.local?.customTools?.read;
			if (!tool) throw new Error("read tool missing");
			const pending = Promise.resolve(tool.execute({ path: "a.ts" }, { toolCallId: "call-crash" }));
			await Promise.resolve();
			bumpToolCount();
			if (cutpoint === "tool-executed") return reach();
			void pending.catch(() => undefined);
			return {
				supports: () => false,
				wait: () => new Promise<RunResult>(() => undefined),
			} as unknown as Run;
		}
		if (cutpoint === "checkpoint-updated") {
			return {
				supports: () => false,
				wait: async () => {
					writeFileSync(join(root, "checkpoint-mark.json"), JSON.stringify({ agentId: "agent-checkpoint-updated" }));
					return reach();
				},
			} as unknown as Run;
		}
		return {
			supports: () => false,
			wait: async () => ({ status: "finished", result: "ok" }) as RunResult,
		} as unknown as Run;
	};

	const options = {
		apiKey: "test-key",
		cwd: root,
		...(cutpoint === "turn-committed" || cutpoint === "host-binding-committed" || cutpoint === "resume-committed"
			? { [HOST_BRIDGE_OPTION_KEY]: host }
			: {}),
	} as SimpleStreamOptions;
	const events = await drain(context, options);
	if (cutpoint === "tool-result-persisted") {
		const done = events.find((event) => event.type === "done");
		if (done?.type === "done") appendMessage(done.message);
		appendMessage({
			role: "toolResult",
			toolCallId: "call-crash",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2,
		});
		return reach();
	}
	if (cutpoint === "host-binding-committed") return reach();
	if (cutpoint === "resume-committed") {
		await handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, ctx);
		return reach();
	}
}

async function recover(): Promise<void> {
	scopeTestUtils.reset();
	runtimeTestUtils.clear();
	liveRunTestUtils.clear();
	resumeTestUtils.reset();
	catalogTestUtils.resetCatalog();
	catalogTestUtils.setListModels(async () => [{ id: "composer-2.5", displayName: "Composer 2.5" }]);
	loadBranch();
	scopeTestUtils.set(root, sessionFile, "crash");
	register();
	await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
	let savedAgentId: string | undefined;
	runtimeTestUtils.setOpenAgent(async (input) => {
		savedAgentId = input.savedAgentId;
		return {
			agentId: input.savedAgentId ?? "agent-recover",
			close() {},
			async [Symbol.asyncDispose]() {},
			async send() {
				return { supports: () => false, wait: async () => ({ status: "finished" }) as RunResult } as unknown as Run;
			},
		} as unknown as SDKAgent;
	});
	const latest = [...branch].reverse().find((entry) => entry.customType === CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE);
	const latestState = parseResumeEntryData(latest?.data)?.state;
	const matching = getMatchingResumeHandle("main", credentialScopeId("test-key"), root);
	const context = cutpoint === "tool-result-persisted"
		? {
			messages: [
				{ role: "user", content: "crash-turn-2", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-crash", name: "read", arguments: { path: "a.ts" } }],
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-crash",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			],
			tools: [READ],
		} as Context
		: {
			messages: [
				...secondContext().messages,
				{ role: "user", content: "crash-turn-3", timestamp: 3 },
			],
		};
	const prepared = await prepareTurn({
		modelLimits: MODEL_LIMITS,
		cwd: root,
		agentInstanceId: "main",
		apiKey: "test-key",
		modelSelection: MODEL_SELECTION,
		context,
		grantedTools: cutpoint === "tool-result-persisted" ? [{ name: "read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }] : [],
	});
	const promptKind = prepared.incremental ? "incremental" : prepared.prompt ? "bootstrap" : "none";
	console.log(`RECOVER ${JSON.stringify({
		cutpoint,
		latestState,
		matchingAgentId: matching?.agentId,
		savedAgentId,
		toolCount: toolCount(),
		promptKind,
	})}`);
	if (cutpoint === "tool-executed") {
		const exec = createSharedToolExec(
			[{ name: "read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
			async () => {
				bumpToolCount();
				return { content: [{ type: "text", text: "ok" }], isError: false };
			},
			"recover-replay",
		);
		await exec.execute("read", { path: "replay.ts" }, "call-replay");
	}
}

try {
	if (mode === "write") {
		await seed();
		await writeTurn();
		await reach();
	} else {
		await recover();
	}
} catch (error) {
	console.error(error instanceof Error ? error.stack ?? error.message : error);
	process.exit(2);
}
