import type { SDKAgent, Run, RunResult } from "@cursor/sdk";
import type { AssistantMessage, AssistantMessageEventStream, Context } from "@oh-my-pi/pi-ai";
import type { HostToolResult } from "./contracts.js";
import { toolResultToHost, trailingToolResults } from "./omp-tools.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";
import type { SharedToolExec } from "./host-exec.js";

export interface ParkedToolCall {
	name: string;
	args: Record<string, unknown>;
	toolCallId: string;
	resolve: (result: HostToolResult) => void;
	reject: (error: Error) => void;
}

export interface LiveRun {
	agent?: SDKAgent;
	run?: Run;
	wait: Promise<RunResult>;
	starting?: Promise<RunResult>;
	parked: ParkedToolCall[];
	onPark?: () => void;
	toolExec: SharedToolExec;
	sink?: { stream: AssistantMessageEventStream; partial: AssistantMessage };
}

const liveRuns = new Map<string, LiveRun>();

export function liveRunKey(scopeKey: string, agentInstanceId: string): string {
	return `${scopeKey}::${agentInstanceId}`;
}

export function getLiveRun(key: string): LiveRun | undefined {
	return liveRuns.get(key);
}

export function setLiveRun(key: string, run: LiveRun): void {
	liveRuns.set(key, run);
}

export function createLiveRun(toolExec: SharedToolExec): LiveRun {
	return {
		wait: new Promise<RunResult>(() => undefined),
		parked: [],
		toolExec,
	};
}

export function attachRun(live: LiveRun, run: Run): void {
	live.run = run;
	live.wait = run.wait();
}

export function startSend(live: LiveRun, start: () => Promise<Run>): Promise<RunResult> {
	live.starting = start().then((run) => {
		attachRun(live, run);
		return live.wait;
	});
	return live.starting;
}

export function waitForResult(live: LiveRun): Promise<RunResult> {
	return live.starting ?? live.wait;
}

export function parkToolCall(run: LiveRun, name: string, args: Record<string, unknown>, toolCallId: string): Promise<HostToolResult> {
	return new Promise((resolve, reject) => {
		run.parked.push({ name, args, toolCallId, resolve, reject });
		run.onPark?.();
	});
}

export function waitForParked(run: LiveRun): Promise<void> {
	if (run.parked.length > 0) return Promise.resolve();
	return new Promise((resolve) => {
		run.onPark = () => {
			run.onPark = undefined;
			resolve();
		};
	});
}

export function stopWaitingForPark(run: LiveRun): void {
	run.onPark = undefined;
}

export async function collectParkedBatch(run: LiveRun): Promise<ParkedToolCall[]> {
	let count = run.parked.length;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		if (run.parked.length === count) break;
		count = run.parked.length;
	}
	return [...run.parked];
}

export function resumeParked(run: LiveRun, context: Context): void {
	const results = trailingToolResults(context);
	const byId = new Map(results.map((result) => [result.toolCallId, result]));
	const parked = run.parked.splice(0, run.parked.length);
	for (const call of parked) {
		const result = byId.get(call.toolCallId);
		if (!result) {
			call.reject(new Error(`OMP did not return a tool result for ${call.name} (${call.toolCallId})`));
			continue;
		}
		call.resolve(toolResultToHost(result));
	}
}

export async function disposeAgent(agent: SDKAgent): Promise<void> {
	await withSdkExitSuppressed(async () => {
		try {
			await agent[Symbol.asyncDispose]();
		} catch {
			try {
				agent.close();
			} catch {
				// Disposal can race with SDK teardown.
			}
		}
	});
}

export async function disposeLiveRun(key: string, reason: string, disposeAgentInstance = true): Promise<void> {
	const run = liveRuns.get(key);
	if (!run) return;
	liveRuns.delete(key);
	stopWaitingForPark(run);
	for (const call of run.parked.splice(0, run.parked.length)) {
		call.reject(new Error(reason));
	}
	try {
		if (run.run?.supports("cancel")) await run.run.cancel();
	} catch {
		// The SDK run may already have finished.
	}
	if (disposeAgentInstance && run.agent) await disposeAgent(run.agent);
}

export function takeLiveRun(key: string): LiveRun | undefined {
	const run = liveRuns.get(key);
	if (!run) return undefined;
	liveRuns.delete(key);
	return run;
}

export const __testUtils = {
	clear() {
		liveRuns.clear();
	},
};
