import { describe, expect, test } from "bun:test";
import type { Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Run, RunResult } from "@cursor/sdk";
import { createSharedToolExec } from "../../src/host-exec.ts";
import { ToolBridgeError } from "../../src/tools.ts";
import {
	__testUtils as liveRunTestUtils,
	bindLiveAbort,
	createLiveRun,
	disposeLiveRun,
	getLiveRun,
	parkToolCall,
	resumeParked,
	setLiveRun,
	startSend,
	type LiveRun,
} from "../../src/live-run.ts";

const KEY = "stress::main";
const TEMPLATES = ["happy", "cancel-park", "pre-attach-cancel", "supersede-stale"] as const;
type Template = (typeof TEMPLATES)[number];

const HAPPY = ["park-a", "park-b", "resume-results", "resolve-send", "emit-delta", "resolve-wait-finished"] as const;
const CANCEL_PARK = ["park-a", "park-b", "abort", "dispose", "resolve-send", "resolve-wait-finished"] as const;
const PRE_ATTACH = ["abort", "park-a", "resolve-send", "resolve-wait-finished", "emit-delta"] as const;
const SUPERSEDE_AFTER = [
	"A:resolve-send",
	"A:emit-delta",
	"A:resolve-wait-finished",
	"A:resume-results",
	"B:park-a",
	"B:park-b",
	"B:resume-results",
	"B:abort",
	"B:resolve-send",
	"B:emit-delta",
	"B:resolve-wait-finished",
] as const;

const READ = { name: "read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } };

function parseSeeds(): number[] {
	const raw = process.env.OMP_STRESS_SEED;
	if (raw === undefined || raw === "") return Array.from({ length: 64 }, (_, i) => i + 1);
	if (!/^[0-9]+$/.test(raw)) throw new Error(`invalid OMP_STRESS_SEED: ${raw}`);
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new Error(`invalid OMP_STRESS_SEED: ${raw}`);
	return [n];
}

function xorshift32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

interface Observer {
	settled: boolean;
	outcome: "pending" | "resolved" | "rejected";
	promise: Promise<unknown>;
}

function observe(promise: Promise<unknown>): Observer {
	const observer: Observer = { settled: false, outcome: "pending", promise };
	observer.promise = promise.then(
		(value) => {
			observer.settled = true;
			observer.outcome = "resolved";
			return value;
		},
		(error) => {
			observer.settled = true;
			observer.outcome = "rejected";
			throw error;
		},
	);
	void observer.promise.catch(() => undefined);
	return observer;
}

interface Actor {
	label: "A" | "B";
	live: LiveRun;
	hostCount: { n: number };
	entered: Map<string, () => void>;
	send: PromiseWithResolvers<Run>;
	wait: PromiseWithResolvers<RunResult>;
	attached: PromiseWithResolvers<void>;
	sendResolved: boolean;
	waitSettled: boolean;
	waitAttached: boolean;
	parkedIds: Set<string>;
	callbacks: Map<string, Observer>;
	controller: AbortController;
	starting: Observer;
}

function fail(seed: number, template: string, trace: string[], name: string, detail = ""): never {
	throw new Error(`seed=${seed} template=${template} invariant=${name} trace=${trace.join(",")} ${detail}`.trimEnd());
}

function createActor(label: "A" | "B", bridgeRunId: string): Actor {
	const hostCount = { n: 0 };
	const entered = new Map<string, () => void>();
	let live: LiveRun;
	live = createLiveRun(
		createSharedToolExec(
			[READ],
			async (_name, _args, toolCallId) => {
				hostCount.n += 1;
				const parked = parkToolCall(live, "read", _args, toolCallId, toolCallId);
				entered.get(toolCallId)?.();
				return parked;
			},
			bridgeRunId,
		),
	);
	const send = Promise.withResolvers<Run>();
	const wait = Promise.withResolvers<RunResult>();
	const attached = Promise.withResolvers<void>();
	const controller = new AbortController();
	live.sink = {
		stream: { push() {}, end() {} },
		partial: { role: "assistant", content: [], stopReason: "stop" },
	} as unknown as LiveRun["sink"];
	bindLiveAbort(live, controller.signal);
	const starting = observe(startSend(live, () => send.promise));
	return {
		label,
		live,
		hostCount,
		entered,
		send,
		wait,
		attached,
		sendResolved: false,
		waitSettled: false,
		waitAttached: false,
		parkedIds: new Set(),
		callbacks: new Map(),
		controller,
		starting,
	};
}

function fakeRun(actor: Actor): Run {
	return {
		supports: (op: string) => op === "cancel",
		cancel: async () => undefined,
		wait: () => {
			if (!actor.waitAttached) {
				actor.waitAttached = true;
				actor.attached.resolve();
			}
			return actor.wait.promise;
		},
	} as unknown as Run;
}

function snapshot(live: LiveRun) {
	return {
		cancelled: live.cancelled,
		parked: live.parked.length,
		answer: live.projection.answerText,
		run: live.run,
	};
}

async function runRound(seed: number, template: Template, trace: string[] = []): Promise<string[]> {
	liveRunTestUtils.clear();
	trace.length = 0;
	const observers: Observer[] = [];
	const boom = (name: string, detail?: string): never => fail(seed, template, trace, name, detail);
	const a = createActor("A", "bridge-a");
	observers.push(a.starting);
	setLiveRun(KEY, a.live);
	let b: Actor | undefined;
	let superseded = false;

	if (template === "supersede-stale") {
		await parkCall(a, "call-a", { path: "a.ts" }, observers, boom);
	}

	const next = xorshift32(seed);
	try {
		for (let step = 0; step < 32; step++) {
			const candidates = enabled(template, a, b, superseded);
			if (candidates.length === 0) break;
			const event = candidates[next() % candidates.length]!;
			trace.push(event);
			const owner = event.includes(":") ? event.split(":")[0] : undefined;
			const name = owner ? event.slice(2) : event;
			let actor: Actor = a;
			if (owner === "B") {
				if (!b) boom("missing-actor", event);
				actor = b;
			}
			const other = actor === a ? b : a;
			const before = other ? snapshot(other.live) : undefined;
			const created = await fire(name, actor, observers, boom, async () => {
				superseded = true;
				return supersedeToB(observers);
			});
			if (created) b = created;
			if (other && before) {
				if (other.live.cancelled !== before.cancelled) boom("stale-isolation", `${event} mutated ${other.label}.cancelled`);
				if (other.live.parked.length !== before.parked) boom("stale-isolation", `${event} mutated ${other.label}.parked`);
				if (other.live.projection.answerText !== before.answer) boom("stale-isolation", `${event} mutated ${other.label}.sink`);
			}
			if (getLiveRun(KEY) && getLiveRun(KEY) !== a.live && getLiveRun(KEY) !== b?.live) boom("single-owner");
			if (a.parkedIds.has("call-a") && a.hostCount.n < 1) boom("exec-count", "park-a missing underlying run");
		}

		await release(a);
		if (b) await release(b);
		await disposeLiveRun(KEY, "stress-end");
		for (const observer of observers) {
			if (!observer.settled) boom("observer-unsettled");
		}
		if (a.live.parked.length !== 0) boom("parked-residual");
		if (b && b.live.parked.length !== 0) boom("parked-residual");
		if (a.live.parkWaiters.size || a.live.cancelWaiters.size || a.live.resultWaiters.size || a.live.abortSignal || a.live.abortHandler) boom("listener-residual");
		if (b && (b.live.parkWaiters.size || b.live.cancelWaiters.size || b.live.resultWaiters.size || b.live.abortSignal || b.live.abortHandler)) boom("listener-residual");
		if (getLiveRun(KEY)) boom("map-residual");
		return trace;
	} finally {
		liveRunTestUtils.clear();
	}
}

function enabled(template: Template, a: Actor, b: Actor | undefined, superseded: boolean): string[] {
	if (template === "supersede-stale" && !superseded) return ["supersede"];
	const names = template === "happy" ? HAPPY
		: template === "cancel-park" ? CANCEL_PARK
		: template === "pre-attach-cancel" ? PRE_ATTACH
		: SUPERSEDE_AFTER;
	return names.filter((event) => {
		if (template === "supersede-stale") {
			const owner = event.slice(0, 1);
			const name = event.slice(2);
			const actor = owner === "B" ? b : a;
			return !!actor && canFire(name, actor);
		}
		return canFire(event, a);
	});
}

function canFire(name: string, actor: Actor): boolean {
	if (name === "park-a") return !actor.live.cancelled && !actor.parkedIds.has("call-a");
	if (name === "park-b") return !actor.live.cancelled && !actor.parkedIds.has("call-b");
	if (name === "resume-results") return !actor.live.cancelled && actor.live.parked.length > 0;
	if (name === "abort") return !actor.live.cancelled;
	if (name === "dispose") return getLiveRun(KEY) === actor.live;
	if (name === "resolve-send") return !actor.sendResolved;
	if (name === "emit-delta") return !!actor.live.run && !actor.waitSettled;
	if (name === "resolve-wait-finished" || name === "resolve-wait-cancelled") {
		return !!actor.live.run && !actor.waitSettled;
	}
	if (name === "supersede") return getLiveRun(KEY) === actor.live;
	return false;
}

async function fire(
	name: string,
	actor: Actor,
	observers: Observer[],
	boom: (name: string, detail?: string) => never,
	doSupersede: () => Promise<Actor>,
): Promise<Actor | undefined> {
	if (name === "park-a") {
		await parkCall(actor, "call-a", { path: "a.ts" }, observers, boom);
		return;
	}
	if (name === "park-b") {
		await parkCall(actor, "call-b", { path: "b.ts" }, observers, boom);
		return;
	}
	if (name === "resume-results") {
		const ompIds = actor.live.parked.map((call) => call.ompToolCallId);
		const sdkIds = actor.live.parked.map((call) => call.sdkToolCallId);
		resumeParked(actor.live, { messages: ompIds.map((id) => toolResult(id, `ok:${id}`)) } as Context);
		await Promise.all(sdkIds.map((id) => actor.callbacks.get(id)!.promise));
		return;
	}
	if (name === "abort") {
		const pending = [...actor.callbacks.values()].filter((observer) => !observer.settled).map((observer) => observer.promise);
		actor.controller.abort();
		await Promise.allSettled(pending);
		if (!actor.live.cancelled) boom("abort", "live.cancelled is false");
		return;
	}
	if (name === "dispose") {
		await disposeLiveRun(KEY, "disposed");
		if (getLiveRun(KEY) === actor.live) boom("dispose", "live still in map");
		return;
	}
	if (name === "resolve-send") {
		actor.sendResolved = true;
		actor.send.resolve(fakeRun(actor));
		await actor.attached.promise;
		if (!actor.live.run) boom("resolve-send", "run not attached");
		return;
	}
	if (name === "emit-delta") {
		if (!actor.live.cancelled && actor.live.sink) actor.live.projection.answerText += "Δ";
		return;
	}
	if (name === "resolve-wait-finished") {
		const cancelled = actor.live.cancelled;
		actor.waitSettled = true;
		actor.wait.resolve({ status: "finished" } as RunResult);
		await actor.wait.promise;
		if (cancelled && !actor.live.cancelled) boom("no-resurrection");
		return;
	}
	if (name === "resolve-wait-cancelled") {
		actor.waitSettled = true;
		actor.wait.resolve({ status: "cancelled" } as RunResult);
		await actor.wait.promise;
		return;
	}
	if (name === "supersede") {
		const next = await doSupersede();
		if (getLiveRun(KEY) !== next.live) boom("supersede", "B is not current");
		if (getLiveRun(KEY) === actor.live) boom("supersede", "A still current");
		return next;
	}
	boom("unknown-event", name);
}

async function supersedeToB(observers: Observer[]): Promise<Actor> {
	await disposeLiveRun(KEY, "superseded");
	const b = createActor("B", "bridge-b");
	observers.push(b.starting);
	setLiveRun(KEY, b.live);
	return b;
}

async function parkCall(
	actor: Actor,
	id: string,
	args: Record<string, unknown>,
	observers: Observer[],
	boom: (name: string, detail?: string) => never,
): Promise<void> {
	const before = actor.hostCount.n;
	const entered = Promise.withResolvers<void>();
	actor.entered.set(id, () => entered.resolve());
	const callback = observe(actor.live.toolExec.execute("read", args, id));
	actor.callbacks.set(id, callback);
	observers.push(callback);
	await entered.promise;
	actor.parkedIds.add(id);
	if (!actor.live.parked.some((call) => call.sdkToolCallId === id)) boom("park", `${id} missing from parked`);
	if (actor.hostCount.n !== before + 1) boom("exec-count", `${id} hostCount ${actor.hostCount.n}`);
}

async function release(actor: Actor): Promise<void> {
	if (!actor.sendResolved) {
		actor.sendResolved = true;
		actor.send.resolve(fakeRun(actor));
	}
	if (!actor.waitSettled) {
		actor.waitSettled = true;
		actor.wait.resolve({ status: "cancelled" } as RunResult);
	}
	await Promise.allSettled([actor.starting.promise, actor.wait.promise, ...[...actor.callbacks.values()].map((observer) => observer.promise)]);
}

async function withWatchdog(seed: number, template: Template, trace: string[], run: () => Promise<string[]>): Promise<string[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run(),
			new Promise<string[]>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`seed=${seed} template=${template} invariant=watchdog trace=${trace.join(",")}`));
				}, 5_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe("live-run state-machine stress", () => {
	test("seeded templates preserve LiveRun invariants", async () => {
		const traces = new Map<string, string[]>();
		for (const seed of parseSeeds()) {
			for (const template of TEMPLATES) {
				const holder: string[] = [];
				const trace = await withWatchdog(seed, template, holder, () => runRound(seed, template, holder));
				traces.set(`${seed}:${template}`, trace);
			}
		}
		expect(traces.size).toBeGreaterThan(0);
	});

	test("the same seed replays the same event order", async () => {
		const seed = 481;
		const first: string[][] = [];
		const second: string[][] = [];
		for (const template of TEMPLATES) {
			first.push(await runRound(seed, template));
			second.push(await runRound(seed, template));
		}
		expect(second).toEqual(first);
	});

	test("duplicate-same parks once and inflight same-id does not re-execute", async () => {
		liveRunTestUtils.clear();
		try {
			const actor = createActor("A", "bridge-a");
			setLiveRun(KEY, actor.live);
			const observers: Observer[] = [actor.starting];
			const boom = (name: string, detail?: string): never => fail(1, "happy", ["park-a"], name, detail);
			await parkCall(actor, "call-a", { path: "a.ts" }, observers, boom);
			const again = observe(actor.live.toolExec.execute("read", { path: "a.ts" }, "call-a"));
			observers.push(again);
			expect(actor.live.parked).toHaveLength(1);
			expect(actor.hostCount.n).toBe(1);
			resumeParked(actor.live, { messages: [toolResult("call-a", "ok:call-a")] } as Context);
			await actor.callbacks.get("call-a")!.promise;
			await again.promise;
			expect(again.outcome).toBe("resolved");
			expect(actor.hostCount.n).toBe(1);
			await release(actor);
			await disposeLiveRun(KEY, "end");
		} finally {
			liveRunTestUtils.clear();
		}
	});

	test("duplicate-conflict rejects while the first call is still inflight", async () => {
		liveRunTestUtils.clear();
		try {
			const actor = createActor("A", "bridge-a");
			setLiveRun(KEY, actor.live);
			const observers: Observer[] = [actor.starting];
			const boom = (name: string, detail?: string): never => fail(1, "happy", ["park-a"], name, detail);
			await parkCall(actor, "call-a", { path: "a.ts" }, observers, boom);
			await expect(actor.live.toolExec.execute("read", { path: "other.ts" }, "call-a")).rejects.toBeInstanceOf(ToolBridgeError);
			expect(actor.live.parked).toHaveLength(1);
			expect(actor.hostCount.n).toBe(1);
			resumeParked(actor.live, { messages: [toolResult("call-a", "ok:call-a")] } as Context);
			await actor.callbacks.get("call-a")!.promise;
			await release(actor);
			await disposeLiveRun(KEY, "end");
		} finally {
			liveRunTestUtils.clear();
		}
	});

	test("duplicate-conflict rejects after the first call settles", async () => {
		liveRunTestUtils.clear();
		try {
			const actor = createActor("A", "bridge-a");
			setLiveRun(KEY, actor.live);
			const observers: Observer[] = [actor.starting];
			const boom = (name: string, detail?: string): never => fail(1, "happy", ["park-a"], name, detail);
			await parkCall(actor, "call-a", { path: "a.ts" }, observers, boom);
			resumeParked(actor.live, { messages: [toolResult("call-a", "ok:call-a")] } as Context);
			await actor.callbacks.get("call-a")!.promise;
			await expect(actor.live.toolExec.execute("read", { path: "other.ts" }, "call-a")).rejects.toBeInstanceOf(ToolBridgeError);
			expect(actor.hostCount.n).toBe(1);
			await release(actor);
			await disposeLiveRun(KEY, "end");
		} finally {
			liveRunTestUtils.clear();
		}
	});

	test("different bridgeRunId values allow the same toolCallId", async () => {
		liveRunTestUtils.clear();
		try {
			const left = createActor("A", "bridge-a");
			const right = createActor("B", "bridge-b");
			const observers: Observer[] = [left.starting, right.starting];
			const boom = (name: string, detail?: string): never => fail(1, "happy", [], name, detail);
			await parkCall(left, "call-1", { path: "a.ts" }, observers, boom);
			await parkCall(right, "call-1", { path: "a.ts" }, observers, boom);
			expect(left.live.parked).toHaveLength(1);
			expect(right.live.parked).toHaveLength(1);
			expect(left.hostCount.n).toBe(1);
			expect(right.hostCount.n).toBe(1);
			resumeParked(left.live, { messages: [toolResult("call-1", "ok")] } as Context);
			resumeParked(right.live, { messages: [toolResult("call-1", "ok")] } as Context);
			await left.callbacks.get("call-1")!.promise;
			await right.callbacks.get("call-1")!.promise;
			await release(left);
			await release(right);
		} finally {
			liveRunTestUtils.clear();
		}
	});
});
