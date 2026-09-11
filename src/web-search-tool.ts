import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveCursorApiKey } from "./auth.js";
import { CURSOR_API_KEY_ENV_VAR, CURSOR_SDK_PROVIDER_ID } from "./constants.js";
import { runCursorWebSearch } from "./cursor-web-search.js";

type SearchContext = Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "sessionManager" | "invokeTool">;

export function registerCursorWebSearchTool(pi: Pick<ExtensionAPI, "registerTool" | "zod">): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		approval: "read",
		strict: true,
		description: "Web search: current information beyond knowledge cutoff.",
		parameters: pi.zod.object({
			query: pi.zod.string(),
			recency: pi.zod.enum(["day", "week", "month", "year"]).optional(),
			limit: pi.zod.number().optional(),
			max_tokens: pi.zod.number().optional(),
			temperature: pi.zod.number().optional(),
			num_search_results: pi.zod.number().optional(),
		}),
		execute: (_toolCallId, params, signal, onUpdate, ctx) =>
			executeCursorWebSearchTool(params, ctx, signal, onUpdate),
	});
}

export async function executeCursorWebSearchTool(
	params: unknown,
	ctx: SearchContext,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback,
): Promise<AgentToolResult> {
	const args = params !== null && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
	const fallback = (error?: unknown): Promise<AgentToolResult> => {
		signal?.throwIfAborted();
		if (!ctx.invokeTool) throw error ?? new Error("OMP native web_search is unavailable");
		return ctx.invokeTool(args, { signal, onUpdate });
	};
	if (ctx.model?.provider === CURSOR_SDK_PROVIDER_ID) return fallback();
	try {
		signal?.throwIfAborted();
		const sessionId = ctx.sessionManager?.getSessionId();
		let apiKey = resolveCursorApiKey(await ctx.modelRegistry?.authStorage?.getApiKey(CURSOR_SDK_PROVIDER_ID, sessionId, { signal }));
		if (!apiKey || apiKey === "N/A") apiKey = resolveCursorApiKey(await ctx.modelRegistry?.getApiKeyForProvider?.(CURSOR_SDK_PROVIDER_ID, sessionId));
		if (!apiKey || apiKey === "N/A") apiKey = resolveCursorApiKey(process.env[CURSOR_API_KEY_ENV_VAR]);
		if (!apiKey || apiKey === "N/A" || typeof args.query !== "string" || !args.query.trim()) return fallback();
		return await runCursorWebSearch({
			apiKey,
			cwd: ctx.cwd,
			query: args.query,
			recency: typeof args.recency === "string" ? args.recency : undefined,
			limit: typeof args.limit === "number" ? args.limit : undefined,
			num_search_results: typeof args.num_search_results === "number" ? args.num_search_results : undefined,
			signal,
		});
	} catch (error) {
		if (signal?.aborted || (error && typeof error === "object" && "name" in error && error.name === "AbortError")) throw error;
		return fallback(error);
	}
}
