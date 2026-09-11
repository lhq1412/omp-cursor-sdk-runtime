import "./sdk-exit-guard.js";
import { Agent, JsonlLocalAgentStore, type AgentOptions, type SDKAgent } from "@cursor/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_ID } from "./constants.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";

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
}

let createAgent = (options: AgentOptions): Promise<SDKAgent> => Agent.create(options);

export async function runCursorWebSearch(params: CursorWebSearchParams): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	try {
		params.signal?.throwIfAborted();
		return await withSdkExitSuppressed(async () => {
			const root = await mkdtemp(join(tmpdir(), "omp-cursor-web-search-"));
			let agent: SDKAgent | undefined;
			let cancel: (() => void) | undefined;
			try {
				params.signal?.throwIfAborted();
				agent = await createAgent({
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
				params.signal?.throwIfAborted();
				const prompt = ["Use the webSearch tool to search the web for the query below. Return an answer with source URLs.", `Query: ${params.query}`];
				for (const key of ["recency", "limit", "num_search_results"] as const) {
					if (params[key] !== undefined) prompt.push(`${key}: ${params[key]}`);
				}
				const run = await agent.send(prompt.join("\n"));
				cancel = () => { void run.cancel().catch(() => {}); };
				params.signal?.addEventListener("abort", cancel, { once: true });
				if (params.signal?.aborted) cancel();
				params.signal?.throwIfAborted();
				let didWebSearch = false;
				for await (const event of run.stream()) {
					params.signal?.throwIfAborted();
					if (event.type === "tool_call" && isWebSearchToolName(event.name)) didWebSearch = true;
				}
				const result = await run.wait();
				params.signal?.throwIfAborted();
				if (result.status === "cancelled") throw new DOMException("Cursor web search was cancelled", "AbortError");
				if (result.status === "error") throw new Error(result.error?.message ?? "Cursor web search failed");
				if (!didWebSearch) throw new CursorSearchNotPerformedError();
				let text = result.result?.trim();
				if (!text) throw new Error("Cursor web search returned an empty answer");
				if (!text.includes("## Sources")) {
					const urls = [...new Set((text.match(/https?:\/\/[^\s<>"\)\]]+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, "")))];
					if (urls.length) text += `\n\n## Sources\n${urls.map((url) => `- ${url}`).join("\n")}`;
				}
				return { content: [{ type: "text" as const, text }] };
			} finally {
				if (cancel) params.signal?.removeEventListener("abort", cancel);
				try {
					await agent?.[Symbol.asyncDispose]();
				} finally {
					await rm(root, { recursive: true, force: true });
				}
			}
		});
	} catch (error) {
		if (params.signal?.aborted) throw new DOMException("Cursor web search was aborted", "AbortError");
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
