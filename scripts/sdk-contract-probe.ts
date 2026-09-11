import "../src/sdk-exit-guard.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type Run, type RunResult, type SDKAgent } from "@cursor/sdk";
import { DEFAULT_MODEL_ID, SDK_TOOL_CONTEXT, SYSTEM_PROMPT_REPLACEMENT } from "../src/constants.ts";
import { requireCursorApiKey } from "../src/auth.ts";
import { buildAgentOptions, openAgent, openJsonlStore, type OpenAgentInput } from "../src/sdk-session.ts";
import { readNativeCheckpoint } from "../src/native-history.ts";

interface ProbeResult {
	name: string;
	ok: boolean;
	detail: string;
}

function scrub(text: string, apiKey: string): string {
	return text.split(apiKey).join("<redacted>");
}

function formatRun(result: RunResult, apiKey: string): string {
	return [
		`runId=${result.id} status=${result.status}`,
		result.error?.code ? `code=${result.error.code}` : undefined,
		result.error?.message ? `error=${scrub(result.error.message, apiKey)}` : undefined,
	].filter(Boolean).join(" ");
}

async function main(): Promise<void> {
	const apiKey = requireCursorApiKey();
	const cwd = await mkdtemp(join(tmpdir(), "omp-cursor-runtime-probe-"));
	const store = openJsonlStore(join(cwd, "store"));
	const calls: Array<{ toolCallId?: string }> = [];
	const results: ProbeResult[] = [];
	const historyToken = `native-history-${randomUUID()}`;
	const abort = new AbortController();
	const cancel = () => abort.abort(new Error("Probe cancelled"));
	const timeout = setTimeout(() => abort.abort(new Error("Probe timed out after 180 seconds")), 180_000);
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	let run: Run | undefined;
	let agent: SDKAgent | undefined;
	let resumed: SDKAgent | undefined;
	const pendingCleanup: Promise<unknown>[] = [];
	let releaseTool!: () => void;
	const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
	let paused!: () => void;
	const toolPaused = new Promise<void>((resolve) => { paused = resolve; });
	const bounded = async <T>(operation: Promise<T>): Promise<T> => {
		let onAbort!: () => void;
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(abort.signal.reason);
			abort.signal.addEventListener("abort", onAbort, { once: true });
			if (abort.signal.aborted) onAbort();
		});
		try { return await Promise.race([operation, cancelled]); }
		finally { abort.signal.removeEventListener("abort", onAbort); }
	};
	let previousRoot: string | null | undefined;
	const observe = async (phase: string, agentId: string, handle?: Run) => {
		try {
			const checkpoint = await bounded(readNativeCheckpoint(store, agentId));
			console.log(`CHECKPOINT ${JSON.stringify({ phase, observedAt: Date.now(), ...checkpoint,
				rootChanged: previousRoot === undefined ? null : checkpoint.rootBlobId !== previousRoot,
				runId: handle?.id ?? null, runAgentId: handle?.agentId ?? null, runStatus: handle?.status ?? null })}`);
			previousRoot = checkpoint.rootBlobId;
		} catch (error) {
			abort.signal.throwIfAborted();
			console.log(`CHECKPOINT ${JSON.stringify({ phase, agentId, error: scrub(String(error), apiKey) })}`);
		}
	};
	const send = async (owner: SDKAgent, prompt: string) => {
		const pending = owner.send(prompt);
		// A send that returns after cancellation still belongs to this probe.
		pendingCleanup.push(pending.then((late) => { if (abort.signal.aborted) return late.cancel(); }).catch(() => undefined));
		run = await bounded(pending);
		return run;
	};
	const updateAgent = store.agents.update.bind(store.agents);
	let imported = false;
	store.agents.update = async (input) => {
		if (!imported && input.agent.latestCheckpoint && input.agent.status === "idle" && !input.agent.activeRunId) {
			imported = true;
			await observe("before-import", input.agent.agentId);
			const updated = await updateAgent(input);
			await observe("imported-baseline", input.agent.agentId);
			return updated;
		}
		return updateAgent(input);
	};
	try {
		const input: OpenAgentInput = {
			apiKey, cwd, model: { id: DEFAULT_MODEL_ID }, store, signal: abort.signal,
			customTools: {
				ping: {
					description: "Return the provided token. The only tool you may call.",
					inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
					execute: async (args, context) => {
						calls.push({ toolCallId: context.toolCallId });
						paused();
						await bounded(toolGate);
						return { content: [{ type: "text", text: `pong:${String(args.token ?? "")}` }] };
					},
				},
			},
		};
		const options = buildAgentOptions(input);
		if (options.systemPrompt !== undefined) throw new Error("v1 must not set AgentOptions.systemPrompt");
		results.push({ name: "systemPrompt", ok: SYSTEM_PROMPT_REPLACEMENT === "unsupported",
			detail: "GAP AgentOptions.systemPrompt omitted; sanitized OMP instructions are bootstrap text, not native system-role input" });
		const opening = openAgent({ ...input,
			bootstrapHistory: [{ role: "user", content: `Remember this history token: ${historyToken}.`, timestamp: 1 }],
		});
		pendingCleanup.push(opening.catch(() => undefined));
		agent = await bounded(opening);
		store.agents.update = updateAgent;
		await observe("after-bootstrap", agent.agentId);
		const plain = await send(agent, `${SDK_TOOL_CONTEXT}\n\nReply with the remembered history token. Do not call any tools.`);
		const plainResult = await bounded(plain.wait());
		await observe("plain-settled", agent.agentId, plain);
		results.push({ name: "nativeHistory", ok: plainResult.status === "finished" && Boolean(plainResult.result?.includes(historyToken)), detail: formatRun(plainResult, apiKey) });
		const toolRun = await send(agent, "Call ping with token alpha exactly once, then reply with the remembered history token. Do not use any other tool.");
		const toolResult = toolRun.wait();
		const first = await bounded(Promise.race([toolPaused.then(() => "paused" as const), toolResult.then(() => "finished" as const)]));
		if (first === "paused") await observe("tool-paused", agent.agentId, toolRun);
		releaseTool();
		const result = await bounded(toolResult);
		await observe("tool-settled", agent.agentId, toolRun);
		results.push({ name: "toolCallId", ok: result.status === "finished" && calls.some((call) => Boolean(call.toolCallId)),
			detail: `ids=${calls.map((call) => call.toolCallId ?? "<missing>").join(",")} ${formatRun(result, apiKey)}` });
		results.push({ name: "toolRestriction", ok: first === "paused" && result.status === "finished" && calls.length === 1,
			detail: `custom ping must pause and run exactly once; ${formatRun(result, apiKey)}` });
		await agent[Symbol.asyncDispose]();
		const agentId = agent.agentId;
		agent = undefined;
		const resuming = Agent.resume(agentId, options);
		pendingCleanup.push(resuming.then((late) => { if (abort.signal.aborted) return late[Symbol.asyncDispose](); }).catch(() => undefined));
		resumed = await bounded(resuming);
		await observe("resumed-baseline", resumed.agentId);
		const follow = await send(resumed, "Reply with the remembered history token. Do not call any tools.");
		const followResult = await bounded(follow.wait());
		await observe("resume-settled", resumed.agentId, follow);
		results.push({ name: "resume", ok: followResult.status === "finished" && Boolean(followResult.result?.includes(historyToken)) && calls.length === 1,
			detail: `${formatRun(followResult, apiKey)} agentId=${resumed.agentId}` });
	} finally {
		store.agents.update = updateAgent;
		releaseTool();
		try {
			if (run?.status === "running") await run.cancel();
		} finally {
			try { await resumed?.[Symbol.asyncDispose](); }
			finally {
				try { await agent?.[Symbol.asyncDispose](); }
				finally {
					clearTimeout(timeout);
					process.removeListener("SIGINT", cancel);
					process.removeListener("SIGTERM", cancel);
					// Do not remove the store while a late create/send/resume is still cleaning up.
					await Promise.allSettled(pendingCleanup);
					await rm(cwd, { recursive: true, force: true });
				}
			}
		}
	}
	for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
	if (results.some((result) => !result.ok)) process.exitCode = 1;
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(scrub(message, process.env.CURSOR_API_KEY ?? "<unset>"));
	process.exitCode = 2;
});
