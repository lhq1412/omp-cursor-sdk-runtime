import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { credentialScopeId } from "./auth.js";
import { CURSOR_SDK_PROVIDER_ID } from "./constants.js";
import { sanitizeCursorProviderError } from "./errors.js";
import { listCredentialUsageAgents } from "./session-runtime.js";
import { reportFromAgentUsage } from "./usage.js";

export const cursorSdkUsageProvider: UsageProvider = {
	id: CURSOR_SDK_PROVIDER_ID,
	validatesCredentials: false,
	retainLastGoodOnFailure: false,
	async fetchUsage({ credential, signal }) {
		signal?.throwIfAborted();
		const apiKey = credential.type === "api_key" ? credential.apiKey?.trim() : undefined;
		if (!apiKey) return null;
		const agents = listCredentialUsageAgents(credentialScopeId(apiKey));
		if (!agents.length) return null;

		const query = async (): Promise<UsageReport> => {
			const report: UsageReport = {
				provider: CURSOR_SDK_PROVIDER_ID,
				fetchedAt: Date.now(),
				limits: [],
				notes: ["Process-known live SDK agents for this API key only, across sessions; not current-session usage, account quota, or a complete invoice. Disposed and resume-only agents are excluded."],
			};
			const errors: string[] = [];
			for (const { agent, agentInstanceId } of agents) {
				signal?.throwIfAborted();
				try {
					const usage = await agent.getUsage();
					signal?.throwIfAborted();
					const snapshot = reportFromAgentUsage(agent.agentId, agentInstanceId, usage, Date.now());
					const { tokens, billing } = snapshot;
					const scope = { provider: CURSOR_SDK_PROVIDER_ID };
					report.limits.push({
						id: `${agent.agentId}:tokens`,
						label: `Tokens ${agent.agentId}`,
						scope,
						amount: { used: tokens.totalTokens, unit: "tokens" },
						notes: [
							`Input ${tokens.inputTokens}; output ${tokens.outputTokens}; cache read ${tokens.cacheReadTokens}; cache write ${tokens.cacheWriteTokens}. Agent totals, not a sum of listed runs.`,
							...(tokens.reasoningTokens === undefined ? [] : [`Reasoning ${tokens.reasoningTokens} (included in output).`]),
							`Queried: ${new Date(snapshot.queriedAt).toISOString()}`,
							...(billing.status === "pending" ? ["Billing pending: SDK has not reported agent costs yet."] : []),
						],
					});
					if (billing.status === "reported") {
						report.limits.push(
							{ id: `${agent.agentId}:raw`, label: `Raw cost ${agent.agentId}`, scope, amount: { used: billing.rawUsd, unit: "usd" } },
							{ id: `${agent.agentId}:charged`, label: `Charged ${agent.agentId}`, scope, amount: { used: billing.chargedUsd, unit: "usd" } },
						);
					}
				} catch (error) {
					signal?.throwIfAborted();
					errors.push(`Agent ${agent.agentId}: ${sanitizeCursorProviderError(error, apiKey)}`);
				}
			}
			if (!report.limits.length) throw new Error(errors.join("\n"));
			report.notes!.push(...errors);
			report.fetchedAt = Date.now();
			report.metadata = { queriedAt: report.fetchedAt };
			return report;
		};

		// SDKAgent.getUsage has no AbortSignal option; stop waiting, never cancel the agent's active run.
		if (!signal) return query();
		const { promise: cancelled, reject } = Promise.withResolvers<never>();
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		try {
			return await Promise.race([query(), cancelled]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	},
};
