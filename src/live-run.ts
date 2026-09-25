import type { LocalAgentStore, SDKAgent, Run, RunResult } from "@cursor/sdk";
import type { AssistantMessage, AssistantMessageEventStream, Context } from "@oh-my-pi/pi-ai";
import type { HostToolResult } from "./contracts.js";
import { toolResultToHost, trailingToolResults } from "./omp-tools.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";
import type { SharedToolExec } from "./host-exec.js";
import type { RunProjection } from "./projector.js";
import type { MessageLocator } from "./context.js";

export interface ParkedToolCall {
	name: string;
	args: Record<string, unknown>;
	sdkToolCallId: string;
	ompToolCallId: string;
	yielded: boolean;
	resolve: (result: HostToolResult) => void;
	reject: (error: Error) => void;
}

/** Disposable local wait; dispose() unregisters without resolving. */
export interface LiveWaitHandle<T> {
	promise: Promise<T>;
	dispose(): void;
}

type ResultTerminal =
	| { ok: true; value: RunResult }
	| { ok: false; reason: unknown };

interface ResultWaiter {
	resolve: (value: RunResult) => void;
	reject: (reason: unknown) => void;
}

export interface LiveRun {
	agent?: SDKAgent;
	run?: Run;
	checkpointStore?: LocalAgentStore;
	checkpointBaseline?: { rootBlobId: string | null };
	wait: Promise<RunResult>;
	starting?: Promise<RunResult>;
	requestLocator?: MessageLocator;
	parked: ParkedToolCall[];
	parkWaiters: Set<() => void>;
	cancelWaiters: Set<() => void>;
	resultWaiters: Set<ResultWaiter>;
	resultTerminal?: ResultTerminal;
	resultObserved: boolean;
	toolExec: SharedToolExec;
	sink?: { stream: AssistantMessageEventStream; partial: AssistantMessage };
	cancelled: boolean;
	projection: RunProjection;
	abortSignal?: AbortSignal;
	abortHandler?: () => void;
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
		parkWaiters: new Set(),
		cancelWaiters: new Set(),
		resultWaiters: new Set(),
		resultObserved: false,
		toolExec,
		cancelled: false,
		projection: { answerText: "" },
	};
}

export function activeWaiterCount(live: LiveRun): number {
	return live.cancelWaiters.size + live.resultWaiters.size + live.parkWaiters.size;
}

function wakeAll(waiters: Set<() => void>): void {
	const pending = [...waiters];
	waiters.clear();
	for (const wake of pending) wake();
}

function settleResult(live: LiveRun, terminal: ResultTerminal): void {
	if (live.resultTerminal) return;
	live.resultTerminal = terminal;
	const waiters = [...live.resultWaiters];
	live.resultWaiters.clear();
	for (const waiter of waiters) {
		if (terminal.ok) waiter.resolve(terminal.value);
		else waiter.reject(terminal.reason);
	}
}

function ensureResultObservation(live: LiveRun): void {
	if (live.resultObserved || live.resultTerminal) return;
	live.resultObserved = true;
	const source = live.starting ?? live.wait;
	void Promise.resolve(source).then(
		(value) => settleResult(live, { ok: true, value }),
		(reason) => settleResult(live, { ok: false, reason }),
	);
}

export function attachRun(live: LiveRun, run: Run): void {
	live.run = run;
	live.wait = run.wait();
	if (!live.resultObserved && !live.starting) {
		ensureResultObservation(live);
	}
}

async function cancelAttachedRun(live: LiveRun): Promise<void> {
	try {
		if (live.run?.supports("cancel")) await live.run.cancel();
	} catch {
		// The SDK run may already have finished.
	}
}

export function startSend(live: LiveRun, start: () => Promise<Run>): Promise<RunResult> {
	live.starting = start().then(async (run) => {
		attachRun(live, run);
		if (live.cancelled) await cancelAttachedRun(live);
		return live.wait;
	});
	ensureResultObservation(live);
	return live.starting;
}

export function waitForResult(live: LiveRun): LiveWaitHandle<RunResult> {
	if (live.resultTerminal) {
		const terminal = live.resultTerminal;
		return {
			promise: terminal.ok ? Promise.resolve(terminal.value) : Promise.reject(terminal.reason),
			dispose() {},
		};
	}
	ensureResultObservation(live);
	let settled = false;
	let resolve!: (value: RunResult) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<RunResult>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const waiter: ResultWaiter = {
		resolve(value) {
			if (settled) return;
			settled = true;
			resolve(value);
		},
		reject(reason) {
			if (settled) return;
			settled = true;
			reject(reason);
		},
	};
	live.resultWaiters.add(waiter);
	return {
		promise,
		dispose() {
			if (settled) return;
			settled = true;
			live.resultWaiters.delete(waiter);
		},
	};
}

export function waitForCancelled(live: LiveRun): LiveWaitHandle<void> {
	if (live.cancelled) {
		return { promise: Promise.resolve(), dispose() {} };
	}
	let settled = false;
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	const wake = () => {
		if (settled) return;
		settled = true;
		live.cancelWaiters.delete(wake);
		resolve();
	};
	live.cancelWaiters.add(wake);
	return {
		promise,
		dispose() {
			if (settled) return;
			settled = true;
			live.cancelWaiters.delete(wake);
		},
	};
}

export function parkToolCall(
	run: LiveRun,
	name: string,
	args: Record<string, unknown>,
	sdkToolCallId: string,
	ompToolCallId: string,
): Promise<HostToolResult> {
	if (run.cancelled) {
		return Promise.reject(new Error("Cursor SDK live run was cancelled"));
	}
	return new Promise((resolve, reject) => {
		if (run.cancelled) {
			reject(new Error("Cursor SDK live run was cancelled"));
			return;
		}
		run.parked.push({ name, args, sdkToolCallId, ompToolCallId, yielded: false, resolve, reject });
		wakeAll(run.parkWaiters);
	});
}

export function waitForParked(run: LiveRun): LiveWaitHandle<void> {
	if (run.cancelled || run.parked.length > 0) {
		return { promise: Promise.resolve(), dispose() {} };
	}
	let settled = false;
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	const wake = () => {
		if (settled) return;
		settled = true;
		run.parkWaiters.delete(wake);
		resolve();
	};
	run.parkWaiters.add(wake);
	return {
		promise,
		dispose() {
			if (settled) return;
			settled = true;
			run.parkWaiters.delete(wake);
		},
	};
}

export function stopWaitingForPark(run: LiveRun): void {
	run.parkWaiters.clear();
}

export function unbindLiveAbort(live: LiveRun): void {
	if (live.abortSignal && live.abortHandler) {
		live.abortSignal.removeEventListener("abort", live.abortHandler);
	}
	live.abortSignal = undefined;
	live.abortHandler = undefined;
}

export function bindLiveAbort(live: LiveRun, signal: AbortSignal | undefined, onAbort?: () => void): void {
	unbindLiveAbort(live);
	if (!signal) return;
	const handler = () => {
		void cancelLiveRun(live);
		onAbort?.();
	};
	live.abortSignal = signal;
	live.abortHandler = handler;
	signal.addEventListener("abort", handler);
	if (signal.aborted) handler();
}

export async function cancelLiveRun(live: LiveRun): Promise<void> {
	if (live.cancelled) {
		await cancelAttachedRun(live);
		return;
	}
	live.cancelled = true;
	stopWaitingForPark(live);
	for (const call of live.parked.splice(0, live.parked.length)) {
		call.reject(new Error("Cursor SDK live run was cancelled"));
	}
	wakeAll(live.cancelWaiters);
	await cancelAttachedRun(live);
}

export async function collectParkedBatch(run: LiveRun): Promise<ParkedToolCall[]> {
	let count = run.parked.length;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		if (run.cancelled || run.parked.length === count) break;
		count = run.parked.length;
	}
	const batch = [...run.parked];
	for (const call of batch) call.yielded = true;
	return batch;
}

export function resumeParked(run: LiveRun, context: Context): void {
	const results = trailingToolResults(context);
	const byId = new Map(results.map((result) => [result.toolCallId, result]));
	const parked = run.parked.splice(0, run.parked.length);
	for (const call of parked) {
		if (run.cancelled) {
			call.reject(new Error("Cursor SDK live run was cancelled"));
			continue;
		}
		const result = byId.get(call.ompToolCallId);
		if (result) {
			call.resolve(toolResultToHost(result));
			continue;
		}
		if (!call.yielded) {
			run.parked.push(call);
			continue;
		}
		call.reject(new Error(`OMP did not return a tool result for ${call.name} (${call.ompToolCallId})`));
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
	unbindLiveAbort(run);
	stopWaitingForPark(run);
	run.cancelled = true;
	for (const call of run.parked.splice(0, run.parked.length)) {
		call.reject(new Error(reason));
	}
	wakeAll(run.cancelWaiters);
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
	activeWaiterCount,
};
