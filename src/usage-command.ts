import { Agent } from "@cursor/sdk";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { credentialScopeId, resolveCursorApiKey } from "./auth.js";
import { CURSOR_API_KEY_ENV_VAR, CURSOR_SDK_PROVIDER_ID, DEFAULT_AGENT_INSTANCE_ID } from "./constants.js";
import { sanitizeCursorProviderError } from "./errors.js";
import { getMatchingResumeHandle } from "./session-resume.js";
import { listRuntimeSlots } from "./session-runtime.js";
import { ownerForContext, withCursorSessionOwner } from "./session-scope.js";
import { formatUsageReports, reportFromAgentUsage, type UsageReport } from "./usage.js";

const defaultGetUsageById: typeof Agent.getUsage = (agentId, options) => Agent.getUsage(agentId, options);
let getUsageById = defaultGetUsageById;

export function registerCursorUsage(pi: Pick<ExtensionAPI, "registerCommand">): void {
	pi.registerCommand("cursor-usage", {
		description: "Query official usage for current Cursor SDK agents (not a session invoice)",
		handler: async (_args, ctx) => withCursorSessionOwner(ownerForContext(ctx), async () => {
			const reports: UsageReport[] = [];
			const errors: string[] = [];
			let hasLiveAgent = false;
			for (const slot of listRuntimeSlots()) {
				const agent = slot.agent;
				if (!agent) continue;
				hasLiveAgent = true;
				try {
					const usage = await agent.getUsage();
					reports.push(reportFromAgentUsage(agent.agentId, slot.agentInstanceId, usage, Date.now()));
				} catch (error) {
					errors.push(`Agent ${agent.agentId} (${slot.agentInstanceId}): ${sanitizeCursorProviderError(error)}`);
				}
			}

			if (!hasLiveAgent) {
				let apiKey: string | undefined;
				try {
					const key = await ctx.modelRegistry.getApiKeyForProvider(CURSOR_SDK_PROVIDER_ID);
					apiKey = resolveCursorApiKey(key === "N/A" ? undefined : key) ?? resolveCursorApiKey(process.env[CURSOR_API_KEY_ENV_VAR]);
					const handle = getMatchingResumeHandle(DEFAULT_AGENT_INSTANCE_ID, apiKey ? credentialScopeId(apiKey) : undefined);
					if (!handle) {
						ctx.ui.notify("No current Cursor SDK agent. Run a cursor-sdk turn first, then use /cursor-usage.", "error");
						return;
					}
					const usage = await getUsageById(handle.agentId, apiKey ? { apiKey } : undefined);
					reports.push(reportFromAgentUsage(handle.agentId, handle.agentInstanceId ?? DEFAULT_AGENT_INSTANCE_ID, usage, Date.now()));
				} catch (error) {
					errors.push(`Cursor SDK usage query failed: ${sanitizeCursorProviderError(error, apiKey)}`);
				}
			}

			const message = reports.length ? formatUsageReports(reports) : "Cursor SDK usage queries failed.";
			ctx.ui.notify([message, ...errors].join("\n"), reports.length ? "info" : "error");
		}),
	});
}

export const __testUtils = {
	setGetUsageById(implementation: typeof Agent.getUsage): void {
		getUsageById = implementation;
	},
	reset(): void {
		getUsageById = defaultGetUsageById;
	},
};
