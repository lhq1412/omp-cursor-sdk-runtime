import "./sdk-exit-guard.js";
import { Agent, JsonlLocalAgentStore, type AgentOptions, type Run, type SDKAgent } from "@cursor/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_ID } from "./constants.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";

export const CURSOR_WEB_SEARCH_TIMEOUT_MS = 60_000;

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

function searchFailed(stop: AbortSignal, timedOut: boolean): never {
	if (stop.aborted && !timedOut) throw abortError();
	if (timedOut) throw new Error("Cursor web search timed out");
	throw abortError();
}

async function raceStop<T>(work: Promise<T>, stop: AbortSignal, timedOut: () => boolean): Promise<T> {
	if (stop.aborted) {
		void work.catch(() => undefined);
		searchFailed(stop, timedOut());
	}
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				onAbort = () => reject(timedOut() ? new Error("Cursor web search timed out") : abortError());
				stop.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) stop.removeEventListener("abort", onAbort);
	}
}

export async function runCursorWebSearch(params: CursorWebSearchParams): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	try {
		params.signal?.throwIfAborted();
		return await withSdkExitSuppressed(async () => {
			const root = await mkdtemp(join(tmpdir(), "omp-cursor-web-search-"));
			const stop = new AbortController();
			let timedOut = false;
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
					agent = await raceStop(creating, stop.signal, () => timedOut);
				} catch (error) {
					void creating.then((late) => late[Symbol.asyncDispose]()).catch(() => undefined);
					throw error;
				}
				const prompt = ["Use the webSearch tool to search the web for the query below. Return an answer with source URLs.", `Query: ${params.query}`];
				for (const key of ["recency", "limit", "num_search_results"] as const) {
					if (params[key] !== undefined) prompt.push(`${key}: ${params[key]}`);
				}
				sending = agent.send(prompt.join("\n"));
				try {
					run = await raceStop(sending, stop.signal, () => timedOut);
				} catch (error) {
					void sending.then((late) => late.cancel()).catch(() => undefined);
					throw error;
				}
				const cancelRun = () => { void run?.cancel().catch(() => undefined); };
				stop.signal.addEventListener("abort", cancelRun, { once: true });
				if (stop.signal.aborted) cancelRun();
				const searches = new Map<string, "running" | "completed" | "error">();
				for await (const event of run.stream()) {
					if (stop.signal.aborted) searchFailed(stop.signal, timedOut);
					if (event.type !== "tool_call" || !isWebSearchToolName(event.name)) continue;
					const id = event.call_id;
					if (typeof id !== "string" || !id) continue;
					if (event.status === "completed" || event.status === "error" || event.status === "running") {
						searches.set(id, event.status);
					}
				}
				const result = await raceStop(run.wait(), stop.signal, () => timedOut);
				if (stop.signal.aborted) searchFailed(stop.signal, timedOut);
				if (result.status === "cancelled") throw abortError();
				if (result.status === "error") throw new Error(result.error?.message ?? "Cursor web search failed");
				if (![...searches.values()].some((status) => status === "completed")) throw new CursorSearchNotPerformedError();
				let text = result.result?.trim();
				if (!text) throw new Error("Cursor web search returned an empty answer");
				if (!text.includes("## Sources")) {
					const urls = [...new Set((text.match(/https?:\/\/[^\s<>"\)\]]+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, "")))];
					if (urls.length) text += `\n\n## Sources\n${urls.map((url) => `- ${url}`).join("\n")}`;
				}
				return { content: [{ type: "text" as const, text }] };
			} finally {
				clearTimeout(timer);
				params.signal?.removeEventListener("abort", onUserAbort);
				try {
					await agent?.[Symbol.asyncDispose]();
				} finally {
					await rm(root, { recursive: true, force: true });
				}
			}
		});
	} catch (error) {
		if (params.signal?.aborted) throw abortError();
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
