import "../src/sdk-exit-guard.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type InteractionUpdate, type Run, type RunResult, type RunStatus, type SDKAgent, type SDKCustomToolContext } from "@cursor/sdk";
import { DEFAULT_MODEL_ID, SDK_TOOL_CONTEXT, SYSTEM_PROMPT_REPLACEMENT } from "../src/constants.ts";
import { requireCursorApiKey } from "../src/auth.ts";
import { buildAgentOptions, openAgent, openJsonlStore, type OpenAgentInput } from "../src/sdk-session.ts";
import { readNativeCheckpoint } from "../src/native-history.ts";

const SELF = fileURLToPath(import.meta.url);
const SDK_PIN = "1.0.31";
export const WINDOW_MS = 10_000;
export const SETUP_MS = 60_000;
const CHILD_MS = 180_000;
const REUSE_TOKEN = "probe-reuse-token";
const USAGE = "usage: --cancellation-case cancel|dispose <absolute-temp-root>";

interface ProbeResult {
	name: string;
	ok: boolean;
	detail: string;
}

type CaseKind = "cancel" | "dispose";
type Phase = "setup" | "pending" | "late-release" | "cleanup";
type Outcome =
	| "resolved"
	| "rejected"
	| "pending-at-deadline"
	| "observed"
	| "not-observed"
	| "unsupported"
	| "unknown"
	| "setup-failed";

interface Capability {
	case: CaseKind;
	phase: Phase;
	observation: string;
	outcome: Outcome;
	elapsedMs: number;
	detail?: unknown;
}

export interface Observer<T> {
	promise: Promise<T>;
	state: "pending" | "resolved" | "rejected";
	value?: T;
	error?: unknown;
}

class SetupFailed extends Error {}

export function scrub(text: string, apiKey: string): string {
	return apiKey ? text.split(apiKey).join("<redacted>") : text;
}

function formatRun(result: RunResult, apiKey: string): string {
	return [
		`runId=${result.id} status=${result.status}`,
		result.error?.code ? `code=${result.error.code}` : undefined,
		result.error?.message ? `error=${scrub(result.error.message, apiKey)}` : undefined,
	].filter(Boolean).join(" ");
}

function toolUpdateNote(update: InteractionUpdate): Record<string, unknown> | undefined {
	if (
		update.type !== "partial-tool-call" &&
		update.type !== "tool-call-started" &&
		update.type !== "tool-call-completed" &&
		update.type !== "tool-call-delta"
	) {
		return undefined;
	}
	const note: Record<string, unknown> = { type: update.type };
	if ("callId" in update) note.callId = update.callId;
	if ("modelCallId" in update) note.modelCallId = update.modelCallId;
	if (update.type === "tool-call-delta") {
		note.taskUpdateType = update.taskUpdate.type;
		return note;
	}
	note.toolType = update.toolCall.type;
	if (update.toolCall.type === "mcp") {
		note.toolName = update.toolCall.args.toolName;
		note.providerIdentifier = update.toolCall.args.providerIdentifier;
		const inner = update.toolCall.args.args;
		note.innerArgs = inner === undefined ? "undefined" : Array.isArray(inner) ? "array" : typeof inner;
		if (inner && typeof inner === "object" && !Array.isArray(inner)) {
			const json = JSON.stringify(inner);
			note.argsKeys = Object.keys(inner);
			note.argsJsonLen = json.length;
			note.argsJsonHead = json.slice(0, 96);
		}
	}
	return note;
}

function summarizeArgEvents(
	events: Array<Record<string, unknown>>,
	executeIds: Array<string | undefined>,
): string {
	const types = events.map((event) => String(event.type));
	const before = events.filter((event) => event.beforeExecute === true).length;
	const callIds = [...new Set(events.map((event) => event.callId).filter((id): id is string => typeof id === "string"))];
	const matched = executeIds.filter((id): id is string => Boolean(id)).filter((id) => callIds.includes(id));
	const jsonLens = events.map((event) => event.argsJsonLen).filter((len): len is number => typeof len === "number");
	const heads = events.map((event) => event.argsJsonHead).filter((head): head is string => typeof head === "string");
	const prefixGrow = heads.length >= 2 && heads.every((head, index) => index === 0 || head.startsWith(heads[index - 1]!));
	return [
		`events=${events.length}`,
		`beforeExecute=${before}`,
		`types=${types.join(">") || "<none>"}`,
		`callIds=${callIds.join(",") || "<none>"}`,
		`executeIds=${executeIds.map((id) => id ?? "<missing>").join(",") || "<none>"}`,
		`callIdMatchesExecute=${matched.length > 0}`,
		`argsJsonLens=${jsonLens.join(">") || "<none>"}`,
		`argsPrefixGrow=${prefixGrow}`,
		`innerArgs=${[...new Set(events.map((event) => event.innerArgs).filter(Boolean))].join(",") || "<none>"}`,
		`toolTypes=${[...new Set(events.map((event) => event.toolType).filter(Boolean))].join(",") || "<none>"}`,
	].join(" ");
}

function errorDetail(error: unknown): { name?: string; message: string } {
	if (error instanceof Error) return { name: error.name, message: error.message };
	return { message: String(error) };
}

function emitCapability(apiKey: string, rec: Capability): void {
	const body: Record<string, unknown> = {
		case: rec.case,
		phase: rec.phase,
		observation: rec.observation,
		outcome: rec.outcome,
		elapsedMs: rec.elapsedMs,
	};
	if (rec.detail !== undefined) {
		try {
			body.detail = JSON.parse(scrub(JSON.stringify(rec.detail), apiKey));
		} catch {
			body.detail = { error: "unserializable" };
		}
	}
	console.log(`CAPABILITY ${JSON.stringify(body)}`);
}

export function observePromise<T>(promise: Promise<T>): Observer<T> {
	const obs: Observer<T> = { promise, state: "pending" };
	void promise.then(
		(value) => {
			obs.state = "resolved";
			obs.value = value;
		},
		(error) => {
			obs.state = "rejected";
			obs.error = error;
		},
	);
	return obs;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function awaitDeadline<T>(obs: Observer<T>, deadline = Date.now() + WINDOW_MS): Promise<void> {
	if (obs.state !== "pending") return;
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) return;
	await Promise.race([obs.promise.then(() => undefined, () => undefined), sleep(remainingMs)]);
}

export async function awaitPreparation(
	entered: Observer<void>,
	run: Observer<unknown>,
	deadline: number,
): Promise<"entered" | "finished" | "timeout"> {
	if (entered.state === "resolved") return "entered";
	if (run.state !== "pending") return "finished";
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) return "timeout";
	return Promise.race([
		entered.promise.then(() => "entered" as const),
		run.promise.then(() => "finished" as const, () => "finished" as const),
		sleep(remainingMs).then(() => "timeout" as const),
	]);
}

function attachLate<T>(apiKey: string, obs: Observer<T>, meta: Omit<Capability, "outcome" | "elapsedMs">, startedAt: number, detail?: (obs: Observer<T>) => unknown): void {
	if (obs.state !== "pending") return;
	void obs.promise.then(
		() => emitCapability(apiKey, { ...meta, outcome: "resolved", elapsedMs: Date.now() - startedAt, detail: detail?.(obs) }),
		() => emitCapability(apiKey, { ...meta, outcome: "rejected", elapsedMs: Date.now() - startedAt, detail: detail?.(obs) }),
	);
}

async function observeWindow<T>(
	apiKey: string,
	obs: Observer<T>,
	meta: Omit<Capability, "outcome" | "elapsedMs">,
	startedAt: number,
	detail?: (obs: Observer<T>) => unknown,
): Promise<Observer<T>["state"] | "pending-at-deadline"> {
	await awaitDeadline(obs);
	const elapsedMs = Date.now() - startedAt;
	if (obs.state === "pending") {
		emitCapability(apiKey, { ...meta, outcome: "pending-at-deadline", elapsedMs, detail: detail?.(obs) });
		attachLate(apiKey, obs, meta, startedAt, detail);
		return "pending-at-deadline";
	}
	emitCapability(apiKey, { ...meta, outcome: obs.state, elapsedMs, detail: detail?.(obs) });
	return obs.state;
}

function parseCancellationArgv(): { kind: CaseKind; root: string } | "invalid" | undefined {
	const idx = process.argv.indexOf("--cancellation-case");
	if (idx === -1) return undefined;
	const kind = process.argv[idx + 1];
	const root = process.argv[idx + 2];
	if ((kind !== "cancel" && kind !== "dispose") || !root || !isAbsolute(root)) return "invalid";
	return { kind, root };
}

function failSetup(apiKey: string, kind: CaseKind, observation: string, startedAt: number, detail?: unknown): never {
	emitCapability(apiKey, { case: kind, phase: "setup", observation, outcome: "setup-failed", elapsedMs: Date.now() - startedAt, detail });
	throw new SetupFailed(observation);
}

function emitContext(apiKey: string, kind: CaseKind, startedAt: number, context: SDKCustomToolContext): AbortSignal | undefined {
	const rec = context as SDKCustomToolContext & { signal?: unknown; deadline?: unknown };
	const elapsedMs = Date.now() - startedAt;
	emitCapability(apiKey, {
		case: kind, phase: "setup", observation: "context.keys", outcome: "observed", elapsedMs,
		detail: { keys: Object.keys(rec).sort(), sdk: SDK_PIN },
	});
	const idIn = "toolCallId" in rec;
	const id = rec.toolCallId;
	emitCapability(apiKey, {
		case: kind, phase: "setup", observation: "context.toolCallId",
		outcome: idIn && typeof id === "string" && id.length > 0 ? "observed" : idIn ? "unknown" : "not-observed",
		elapsedMs, detail: { in: idIn, typeof: typeof id },
	});
	const signalIn = "signal" in rec;
	const signal = rec.signal;
	const isAbort = signal instanceof AbortSignal;
	emitCapability(apiKey, {
		case: kind, phase: "setup", observation: "context.signal",
		outcome: !signalIn ? "not-observed" : isAbort ? "observed" : "unknown",
		elapsedMs, detail: { in: signalIn, typeof: typeof signal },
	});
	const deadlineIn = "deadline" in rec;
	emitCapability(apiKey, {
		case: kind, phase: "setup", observation: "context.deadline",
		outcome: !deadlineIn ? "not-observed" : "unknown",
		elapsedMs, detail: { in: deadlineIn, typeof: typeof rec.deadline },
	});
	return isAbort ? signal : undefined;
}

async function boundedCleanup(operation: Promise<unknown>): Promise<void> {
	await Promise.race([operation.then(() => undefined, () => undefined), sleep(WINDOW_MS)]);
}

async function runIsolated(kind: CaseKind, root: string, apiKey: string): Promise<void> {
	const startedAt = Date.now();
	const setupDeadline = startedAt + SETUP_MS;
	const store = openJsonlStore(join(root, "store"));
	const toolGate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const callbackReturned = Promise.withResolvers<unknown>();
	const callbackObs = observePromise(callbackReturned.promise);
	const enteredObs = observePromise(entered.promise);
	const statusTimeline: Array<{ status: RunStatus; elapsedMs: number }> = [];
	let holdEntries = 0;
	let signalNotified = false;
	let released = false;
	let disposed = false;
	let agent: SDKAgent | undefined;
	let run: Run | undefined;
	let waitObs: Observer<RunResult> | undefined;
	let followRun: Run | undefined;
	let unsubscribeStatus: (() => void) | undefined;

	const runDetail = (extra?: Record<string, unknown>) => ({
		sdk: SDK_PIN,
		runStatus: run?.status,
		statusTimeline,
		...extra,
	});

	const releaseGate = () => {
		if (released) return;
		released = true;
		toolGate.resolve();
	};

	const input: OpenAgentInput = {
		apiKey,
		cwd: root,
		model: { id: DEFAULT_MODEL_ID },
		store,
		customTools: {
			hold: {
				description: "Block until released. The only tool you may call, and you must call it exactly once.",
				inputSchema: { type: "object", properties: {} },
				execute: async (_args, context) => {
					holdEntries += 1;
					if (holdEntries === 1) {
						const signal = emitContext(apiKey, kind, startedAt, context);
						if (signal) {
							const onAbort = () => {
								if (signalNotified) return;
								signalNotified = true;
								emitCapability(apiKey, {
									case: kind, phase: "pending", observation: "callback.notification",
									outcome: "observed", elapsedMs: Date.now() - startedAt,
									detail: { sdk: SDK_PIN, aborted: signal.aborted },
								});
							};
							signal.addEventListener("abort", onAbort);
							if (signal.aborted) onAbort();
						}
						entered.resolve();
					}
					try {
						await toolGate.promise;
						const result = { content: [{ type: "text" as const, text: "released" }] };
						if (holdEntries === 1) callbackReturned.resolve(result);
						return result;
					} catch (error) {
						if (holdEntries === 1) callbackReturned.reject(error);
						throw error;
					}
				},
			},
		},
	};

	try {
		const openObs = observePromise(openAgent(input));
		await awaitDeadline(openObs, setupDeadline);
		if (openObs.state === "pending") failSetup(apiKey, kind, "agent.open", startedAt, { sdk: SDK_PIN, error: { message: "pending-at-deadline" } });
		if (openObs.state === "rejected") failSetup(apiKey, kind, "agent.open", startedAt, { sdk: SDK_PIN, error: errorDetail(openObs.error) });
		agent = openObs.value;
		if (!agent) failSetup(apiKey, kind, "agent.open", startedAt, { sdk: SDK_PIN, error: { message: "missing-agent" } });

		const sendObs = observePromise(agent.send("Call hold exactly once. Do not call any other tool."));
		await awaitDeadline(sendObs, setupDeadline);
		if (sendObs.state === "pending") failSetup(apiKey, kind, "run.handle", startedAt, { sdk: SDK_PIN, error: { message: "pending-at-deadline" } });
		if (sendObs.state === "rejected") failSetup(apiKey, kind, "run.handle", startedAt, { sdk: SDK_PIN, error: errorDetail(sendObs.error) });
		run = sendObs.value;
		if (!run) failSetup(apiKey, kind, "run.handle", startedAt, { sdk: SDK_PIN, error: { message: "missing-run" } });
		unsubscribeStatus = run.onDidChangeStatus((status) => {
			statusTimeline.push({ status, elapsedMs: Date.now() - startedAt });
		});
		waitObs = observePromise(run.wait());

		const first = await awaitPreparation(enteredObs, waitObs, setupDeadline);
		if (first !== "entered" || enteredObs.state !== "resolved") {
			failSetup(apiKey, kind, "callback.entered", startedAt, runDetail({
				reason: first === "finished" ? "finished-before-enter" : first === "timeout" ? "entered-timeout" : "missing-callback",
				holdEntries,
			}));
		}

		const supportsCancel = run.supports("cancel");
		if (kind === "dispose") {
			emitCapability(apiKey, {
				case: kind, phase: "pending", observation: "run.cancel", outcome: "unsupported",
				elapsedMs: Date.now() - startedAt,
				detail: runDetail({ reason: "not-applicable" }),
			});
			emitCapability(apiKey, {
				case: kind, phase: "pending", observation: "agent.reusable", outcome: "unknown",
				elapsedMs: Date.now() - startedAt,
				detail: runDetail({ reason: "not-applicable" }),
			});
			const disposeStarted = Date.now();
			const disposeObs = observePromise(agent[Symbol.asyncDispose]());
			disposed = true;
			await observeWindow(apiKey, disposeObs, {
				case: kind, phase: "pending", observation: "agent.dispose",
			}, disposeStarted, (obs) => runDetail(obs.state === "rejected" ? { error: errorDetail(obs.error) } : undefined));
		} else if (!supportsCancel) {
			emitCapability(apiKey, {
				case: kind, phase: "pending", observation: "run.cancel", outcome: "unsupported",
				elapsedMs: Date.now() - startedAt,
				detail: runDetail({ supports: false, reason: run.unsupportedReason("cancel") }),
			});
			emitCapability(apiKey, {
				case: kind, phase: "pending", observation: "agent.reusable", outcome: "unsupported",
				elapsedMs: Date.now() - startedAt,
				detail: runDetail({ reason: "cancel-unsupported" }),
			});
		} else {
			const cancelStarted = Date.now();
			const cancelObs = observePromise(run.cancel());
			await observeWindow(apiKey, cancelObs, {
				case: kind, phase: "pending", observation: "run.cancel",
			}, cancelStarted, (obs) => runDetail(obs.state === "rejected" ? { error: errorDetail(obs.error) } : { supports: true }));
		}

		await observeWindow(apiKey, waitObs, {
			case: kind, phase: "pending", observation: "run.wait",
		}, startedAt, (obs) => runDetail(
			obs.state === "rejected" ? { error: errorDetail(obs.error) }
				: obs.state === "resolved" ? { resultStatus: obs.value?.status } : undefined,
		));

		if (!signalNotified) {
			emitCapability(apiKey, {
				case: kind, phase: "pending", observation: "callback.notification",
				outcome: "not-observed", elapsedMs: Date.now() - startedAt,
				detail: { sdk: SDK_PIN, signal: "not-observed" },
			});
		}

		await observeWindow(apiKey, callbackObs, {
			case: kind, phase: "pending", observation: "callback.pending",
		}, startedAt, (obs) => runDetail({ holdEntries, error: obs.state === "rejected" ? errorDetail(obs.error) : undefined }));

		if (kind === "cancel" && supportsCancel) {
			const followStarted = Date.now();
			const followSend = observePromise(agent.send(`Reply with exactly ${REUSE_TOKEN}. Do not call any tools.`));
			await awaitDeadline(followSend);
			attachLate(apiKey, followSend, { case: kind, phase: "pending", observation: "agent.reusable" }, followStarted, (obs) => runDetail({
				send: obs.state, error: obs.state === "rejected" ? errorDetail(obs.error) : undefined,
			}));
			const next = followSend.value;
			if (followSend.state === "resolved" && next) {
				followRun = next;
				const followWait = observePromise(next.wait());
				await awaitDeadline(followWait);
				attachLate(apiKey, followWait, { case: kind, phase: "pending", observation: "agent.reusable" }, followStarted, (obs) => runDetail({
					send: followSend.state, wait: obs.state,
					tokenReturned: typeof obs.value?.result === "string" && obs.value.result.includes(REUSE_TOKEN),
					resultStatus: obs.value?.status,
					error: obs.state === "rejected" ? errorDetail(obs.error) : undefined,
				}));
				const tokenReturned = followWait.state === "resolved" && typeof followWait.value?.result === "string"
					&& followWait.value.result.includes(REUSE_TOKEN);
				const outcome: Outcome = followWait.state === "pending" ? "pending-at-deadline"
					: followWait.state === "rejected" ? "rejected"
					: tokenReturned ? "observed" : "unknown";
				emitCapability(apiKey, {
					case: kind, phase: "pending", observation: "agent.reusable", outcome,
					elapsedMs: Date.now() - followStarted,
					detail: runDetail({
						send: followSend.state, wait: followWait.state, tokenReturned,
						resultStatus: followWait.value?.status,
						error: followWait.state === "rejected" ? errorDetail(followWait.error) : undefined,
					}),
				});
			} else {
				emitCapability(apiKey, {
					case: kind, phase: "pending", observation: "agent.reusable",
					outcome: followSend.state === "pending" ? "pending-at-deadline" : followSend.state === "rejected" ? "rejected" : "unknown",
					elapsedMs: Date.now() - followStarted,
					detail: runDetail({
						send: followSend.state,
						error: followSend.state === "rejected" ? errorDetail(followSend.error) : undefined,
					}),
				});
			}
		}

		const lateStarted = Date.now();
		releaseGate();
		await observeWindow(apiKey, callbackObs, {
			case: kind, phase: "late-release", observation: "callback.returned",
		}, lateStarted, (obs) => runDetail({ holdEntries, extraCalls: Math.max(0, holdEntries - 1), error: obs.state === "rejected" ? errorDetail(obs.error) : undefined }));
		emitCapability(apiKey, {
			case: kind, phase: "late-release", observation: "lateCallbackAccepted", outcome: "unknown",
			elapsedMs: Date.now() - lateStarted,
			detail: runDetail({ reason: "no-public-accept-channel", extraCalls: Math.max(0, holdEntries - 1) }),
		});

		if (kind === "cancel" && !disposed) {
			const disposeStarted = Date.now();
			const disposeObs = observePromise(agent[Symbol.asyncDispose]());
			disposed = true;
			await observeWindow(apiKey, disposeObs, {
				case: kind, phase: "cleanup", observation: "agent.dispose",
			}, disposeStarted, (obs) => runDetail(obs.state === "rejected" ? { error: errorDetail(obs.error) } : undefined));
		}
	} finally {
		unsubscribeStatus?.();
		releaseGate();
		if (followRun?.status === "running") await boundedCleanup(followRun.cancel());
		if (run?.status === "running" && kind === "cancel") await boundedCleanup(run.cancel());
		if (!disposed && agent) {
			disposed = true;
			await boundedCleanup(agent[Symbol.asyncDispose]());
		}
	}
}

async function runCancellationCase(kind: CaseKind, root: string): Promise<void> {
	const apiKey = requireCursorApiKey();
	const watchdog = setTimeout(() => {
		console.error("cancellation-case watchdog: 180s");
		process.exit(2);
	}, CHILD_MS);
	try {
		await runIsolated(kind, root, apiKey);
		clearTimeout(watchdog);
		process.exit(0);
	} catch (error) {
		clearTimeout(watchdog);
		if (error instanceof SetupFailed) process.exit(2);
		const message = error instanceof Error ? error.message : String(error);
		console.error(scrub(message, apiKey));
		process.exit(2);
	}
}

async function spawnCancellationChild(kind: CaseKind, apiKey: string): Promise<number> {
	const root = await mkdtemp(join(tmpdir(), `omp-cursor-runtime-probe-${kind}-`));
	const child = spawn(process.execPath, [SELF, "--cancellation-case", kind, root], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		process.stdout.write(scrub(chunk, apiKey));
	});
	child.stderr.on("data", (chunk: string) => {
		process.stderr.write(scrub(chunk, apiKey));
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, CHILD_MS);
	const stop = () => child.kill("SIGKILL");
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		return await new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => {
				if (timedOut) resolve(2);
				else if (code !== null) resolve(code);
				else resolve(signal ? 2 : 0);
			});
		});
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await rm(root, { recursive: true, force: true });
	}
}

async function runNativeHistoryProbe(apiKey: string): Promise<boolean> {
	const cwd = await mkdtemp(join(tmpdir(), "omp-cursor-runtime-probe-"));
	const store = openJsonlStore(join(cwd, "store"));
	const calls: Array<{ toolCallId?: string }> = [];
	const echoCalls: Array<{ toolCallId?: string }> = [];
	const toolEvents: Array<Record<string, unknown>> = [];
	const results: ProbeResult[] = [];
	const historyToken = `native-history-${randomUUID()}`;
	const abort = new AbortController();
	const cancel = () => abort.abort(new Error("Probe cancelled"));
	const timeout = setTimeout(() => abort.abort(new Error("Probe timed out after 240 seconds")), 240_000);
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
	const send = async (owner: SDKAgent, prompt: string, phase: string) => {
		const pending = owner.send(prompt, {
			onDelta: ({ update }) => {
				const note = toolUpdateNote(update);
				if (!note) return;
				toolEvents.push({
					phase,
					beforeExecute: phase === "echo" ? echoCalls.length === 0 : calls.length === 0,
					...note,
				});
			},
		});
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
					description: "Return the provided token.",
					inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
					execute: async (args, context) => {
						calls.push({ toolCallId: context.toolCallId });
						paused();
						await bounded(toolGate);
						return { content: [{ type: "text", text: `pong:${String(args.token ?? "")}` }] };
					},
				},
				echo_blob: {
					description: "Return the length of the provided blob. Side-effect free.",
					inputSchema: { type: "object", properties: { blob: { type: "string" } }, required: ["blob"] },
					execute: async (args, context) => {
						echoCalls.push({ toolCallId: context.toolCallId });
						return { content: [{ type: "text", text: `echo:${String(args.blob ?? "").length}` }] };
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
		const plain = await send(agent, `${SDK_TOOL_CONTEXT}\n\nReply with the remembered history token. Do not call any tools.`, "plain");
		const plainResult = await bounded(plain.wait());
		await observe("plain-settled", agent.agentId, plain);
		results.push({ name: "nativeHistory", ok: plainResult.status === "finished" && Boolean(plainResult.result?.includes(historyToken)), detail: formatRun(plainResult, apiKey) });
		const toolRun = await send(agent, "Call ping with token alpha exactly once, then reply with the remembered history token. Do not use any other tool.", "ping");
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
		results.push({
			name: "pingArgEvents",
			ok: true,
			detail: summarizeArgEvents(toolEvents.filter((event) => event.phase === "ping"), calls.map((call) => call.toolCallId)),
		});
		await agent[Symbol.asyncDispose]();
		const agentId = agent.agentId;
		agent = undefined;
		const resuming = Agent.resume(agentId, options);
		pendingCleanup.push(resuming.then((late) => { if (abort.signal.aborted) return late[Symbol.asyncDispose](); }).catch(() => undefined));
		resumed = await bounded(resuming);
		await observe("resumed-baseline", resumed.agentId);
		const follow = await send(resumed, "Reply with the remembered history token. Do not call any tools.", "resume");
		const followResult = await bounded(follow.wait());
		await observe("resume-settled", resumed.agentId, follow);
		results.push({ name: "resume", ok: followResult.status === "finished" && Boolean(followResult.result?.includes(historyToken)) && calls.length === 1,
			detail: `${formatRun(followResult, apiKey)} agentId=${resumed.agentId}` });
		const blob = `probe-blob-${"z".repeat(256)}`;
		const echoRun = await send(resumed, `Call echo_blob exactly once with blob set to this exact string, then stop. Do not call ping.\n${blob}`, "echo");
		const echoResult = await bounded(echoRun.wait());
		await observe("echo-settled", resumed.agentId, echoRun);
		console.log(`ARG_EVENTS ${JSON.stringify(toolEvents)}`);
		const pingEvents = toolEvents.filter((event) => event.phase === "ping");
		const echoEvents = toolEvents.filter((event) => event.phase === "echo");
		results.push({
			name: "customToolArgEvents",
			ok: echoResult.status === "finished" && echoCalls.length >= 1,
			detail: `ping ${summarizeArgEvents(pingEvents, calls.map((call) => call.toolCallId))} echo ${summarizeArgEvents(echoEvents, echoCalls.map((call) => call.toolCallId))} ${formatRun(echoResult, apiKey)}`,
		});
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
	if (results.some((result) => !result.ok)) {
		process.exitCode = 1;
		return false;
	}
	return true;
}

async function main(): Promise<void> {
	const isolated = parseCancellationArgv();
	if (isolated === "invalid") {
		console.error(USAGE);
		process.exit(2);
	}
	if (isolated) {
		await runCancellationCase(isolated.kind, isolated.root);
		return;
	}
	const apiKey = requireCursorApiKey();
	const passed = await runNativeHistoryProbe(apiKey);
	if (!passed) return;
	for (const kind of ["cancel", "dispose"] as const) {
		const code = await spawnCancellationChild(kind, apiKey);
		if (code !== 0) process.exitCode = 2;
	}
}

if (import.meta.main) {
	void main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(scrub(message, process.env.CURSOR_API_KEY ?? "<unset>"));
		process.exitCode = 2;
	});
}
