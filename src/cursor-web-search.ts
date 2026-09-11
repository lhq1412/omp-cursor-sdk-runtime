import "./sdk-exit-guard.js";
import { Agent, JsonlLocalAgentStore, type AgentOptions, type Run, type SDKAgent, type SDKMessage } from "@cursor/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_ID } from "./constants.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";

export const CURSOR_WEB_SEARCH_TIMEOUT_MS = 60_000;
const CLEANUP_MS = 1_000;

export class CursorSearchNotPerformedError extends Error {
	constructor() {
		super("Cursor did not perform a web search");
		this.name = "CursorSearchNotPerformedError";
	}
}

export function isWebSearchToolName(name: string | undefined): boolean {
	const normalized = name?.toLowerCase().replace(/[_-]/g, "");
	return normalized === "websearch" || normalized === "websearchtoolcall";
}

export interface CursorWebSearchParams {
	query: string;
	recency?: string;
	limit?: number;
	num_search_results?: number;
	apiKey: string;
	cwd: string;
	modelId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

let createAgent = (options: AgentOptions): Promise<SDKAgent> => Agent.create(options);

function abortError(): DOMException {
	return new DOMException("Cursor web search was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function stopError(userAborted: boolean, timedOut: boolean): Error {
	if (userAborted) return abortError();
	if (timedOut) return new Error("Cursor web search timed out");
	return new Error("Cursor web search failed");
}

async function raceStop<T>(work: Promise<T>, stop: AbortSignal, fail: () => Error): Promise<T> {
	if (stop.aborted) {
		void work.catch(() => undefined);
		throw fail();
	}
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				onAbort = () => reject(fail());
				stop.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) stop.removeEventListener("abort", onAbort);
	}
}

function later(task: () => Promise<unknown>): void {
	void withSdkExitSuppressed(task).catch(() => undefined);
}

async function bounded(task: Promise<unknown>, ms = CLEANUP_MS): Promise<void> {
	await Promise.race([task.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

export async function runCursorWebSearch(params: CursorWebSearchParams): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	let timedOut = false;
	try {
		params.signal?.throwIfAborted();
		return await withSdkExitSuppressed(async () => {
			const root = await mkdtemp(join(tmpdir(), "omp-cursor-web-search-"));
			const stop = new AbortController();
			const fail = () => stopError(Boolean(params.signal?.aborted), timedOut);
			const timeoutMs = params.timeoutMs ?? CURSOR_WEB_SEARCH_TIMEOUT_MS;
			const timer = timeoutMs > 0 ? setTimeout(() => {
				timedOut = true;
				stop.abort();
			}, timeoutMs) : undefined;
			const onUserAbort = () => stop.abort();
			params.signal?.addEventListener("abort", onUserAbort, { once: true });
			if (params.signal?.aborted) stop.abort();
			let agent: SDKAgent | undefined;
			let creating: Promise<SDKAgent> | undefined;
			let sending: Promise<Run> | undefined;
			let run: Run | undefined;
			try {
				creating = createAgent({
					apiKey: params.apiKey,
					model: { id: params.modelId ?? DEFAULT_MODEL_ID },
					tools: ["webSearch"],
					mcpServers: {},
					local: {
						cwd: params.cwd,
						store: new JsonlLocalAgentStore(root),
						customTools: {},
						settingSources: [],
						enableAgentRetries: false,
					},
				});
				try {
					agent = await raceStop(creating, stop.signal, fail);
				} catch (error) {
					if (!agent) later(async () => { await (await creating)?.[Symbol.asyncDispose](); });
					throw error;
				}
				const prompt = ["Use the webSearch tool to search the web for the query below. Return an answer with source URLs.", `Query: ${params.query}`];
				for (const key of ["recency", "limit", "num_search_results"] as const) {
					if (params[key] !== undefined) prompt.push(`${key}: ${params[key]}`);
				}
				sending = agent.send(prompt.join("\n"));
				try {
					run = await raceStop(sending, stop.signal, fail);
				} catch (error) {
					later(async () => { await (await sending)?.cancel(); });
					throw error;
				}
				const cancelRun = () => {
					const current = run;
					if (current) later(() => current.cancel());
				};
				stop.signal.addEventListener("abort", cancelRun, { once: true });
				if (stop.signal.aborted) cancelRun();
				const searches = new Map<string, "running" | "completed" | "error">();
				const iterator = run.stream()[Symbol.asyncIterator]();
				try {
					while (true) {
						let step: IteratorResult<SDKMessage>;
						try {
							step = await raceStop(iterator.next(), stop.signal, fail);
						} catch (error) {
							void iterator.return?.().catch(() => undefined);
							if (params.signal?.aborted || timedOut) throw fail();
							if (isAbortError(error)) throw fail();
							throw error;
						}
						if (step.done) break;
						const event = step.value;
						if (event.type !== "tool_call" || !isWebSearchToolName(event.name)) continue;
						const id = event.call_id;
						if (typeof id !== "string" || !id) continue;
						if (event.status === "completed" || event.status === "error" || event.status === "running") {
							searches.set(id, event.status);
						}
					}
				} finally {
					void iterator.return?.().catch(() => undefined);
				}
				const result = await raceStop(run.wait(), stop.signal, fail);
				if (result.status === "cancelled") throw fail();
				if (result.status === "error") throw new Error(result.error?.message ?? "Cursor web search failed");
				if (![...searches.values()].some((status) => status === "completed")) throw new CursorSearchNotPerformedError();
				let text = result.result?.trim();
				if (!text) throw new Error("Cursor web search returned an empty answer");
				if (!text.includes("## Sources")) {
					const urls = [...new Set((text.match(/https?:\/\/[^\s<>"\)\]]+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, "")))];
					if (urls.length) text += `\n\n## Sources\n${urls.map((url) => `- ${url}`).join("\n")}`;
				}
				return { content: [{ type: "text" as const, text }] };
			} catch (error) {
				if (params.signal?.aborted || timedOut || isAbortError(error)) throw fail();
				throw error;
			} finally {
				clearTimeout(timer);
				params.signal?.removeEventListener("abort", onUserAbort);
				const current = agent;
				if (current) {
					await bounded(withSdkExitSuppressed(async () => {
						await current[Symbol.asyncDispose]();
					}));
				}
				await bounded(rm(root, { recursive: true, force: true }));
			}
		});
	} catch (error) {
		if (params.signal?.aborted) throw abortError();
		if (timedOut) throw new Error("Cursor web search timed out");
		if (isAbortError(error)) throw new Error("Cursor web search failed");
		throw error;
	}
}

export const __testUtils = {
	setCreateAgent(fn: (options: AgentOptions) => Promise<SDKAgent>): void {
		createAgent = fn;
	},
	reset(): void {
		createAgent = (options) => Agent.create(options);
	},
};
