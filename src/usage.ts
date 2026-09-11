import type { AgentUsage } from "@cursor/sdk";

export type UsageBilling =
	| { status: "reported"; rawUsd: number; chargedUsd: number }
	| { status: "pending" };

export interface UsageReport {
	agentId: string;
	agentInstanceId: string;
	tokens: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
		reasoningTokens?: number;
	};
	billing: UsageBilling;
	detailCount: number;
	queriedAt: number;
}

export function reportFromAgentUsage(
	agentId: string,
	agentInstanceId: string,
	usage: AgentUsage,
	queriedAt: number,
): UsageReport {
	return {
		agentId,
		agentInstanceId,
		tokens: usage.usage,
		billing: usage.cost === undefined
			? { status: "pending" }
			: { status: "reported", rawUsd: usage.cost.rawCostCents / 100, chargedUsd: usage.cost.chargedCents / 100 },
		detailCount: usage.runs.length,
		queriedAt,
	};
}

export function formatUsageReport(report: UsageReport): string {
	const { tokens, billing } = report;
	return [
		"Cursor usage: current SDK agents in this session only; not a complete session invoice.",
		`Agent: ${report.agentId} (instance: ${report.agentInstanceId})`,
		`Tokens: input ${tokens.inputTokens}, output ${tokens.outputTokens}, cache read ${tokens.cacheReadTokens}, cache write ${tokens.cacheWriteTokens}, total ${tokens.totalTokens}`,
		...(tokens.reasoningTokens === undefined ? [] : [`Reasoning tokens: ${tokens.reasoningTokens} (included in output)`]),
		billing.status === "reported"
			? `Raw: $${billing.rawUsd.toFixed(4)}; Charged: $${billing.chargedUsd.toFixed(4)}`
			: "Billing: not reported yet",
		`Queried: ${new Date(report.queriedAt).toISOString()}`,
		`Listed turn count: ${report.detailCount}; agent totals can exceed listed turns.`,
	].join("\n");
}

export function formatUsageReports(reports: UsageReport[]): string {
	return reports.map(formatUsageReport).join("\n\n");
}
