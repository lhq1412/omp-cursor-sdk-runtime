import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentUsage, SDKAgent } from "@cursor/sdk";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { emptySendState } from "../../src/context.ts";
import { __testUtils as resumeTestUtils } from "../../src/session-resume.ts";
import { __testUtils as runtimeTestUtils, runtimeKey } from "../../src/session-runtime.ts";
import {
	__testUtils as scopeTestUtils,
	type CursorSessionOwner,
	ownerForContext,
	ownerForRequest,
	withCursorSessionOwner,
} from "../../src/session-scope.ts";
import { formatUsageReport, formatUsageReports, reportFromAgentUsage } from "../../src/usage.ts";
import { __testUtils as commandTestUtils, registerCursorUsage } from "../../src/usage-command.ts";

const queriedAt = Date.parse("2026-09-11T12:34:56.000Z");

function usageSnapshot(): AgentUsage {
	return {
		usage: { inputTokens: 111, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, totalTokens: 210, reasoningTokens: 7 },
		cost: { rawCostCents: 123.456, chargedCents: 45.678 },
		runs: [{
			runId: "turn-1",
			usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10 },
			cost: { rawCostCents: 5, chargedCents: 2 },
		}],
	};
}

function createHost() {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		cwd: "/tmp/usage-test",
		hasUI: true,
		ui: { notify(message: string, type?: string) { notifications.push({ message, type }); } },
		sessionManager: {
			getSessionId: () => "usage-session",
			getSessionFile: () => undefined,
		},
		modelRegistry: { async getApiKeyForProvider() { return undefined; } },
	} as unknown as ExtensionCommandContext;
	const pi = {
		registerCommand(name, command) { commands.set(name, command.handler); },
	} satisfies Pick<ExtensionAPI, "registerCommand">;
	registerCursorUsage(pi);
	const owner = ownerForContext(ctx);
	withCursorSessionOwner(owner, () => resumeTestUtils.reset());
	return {
		owner,
		notifications,
		async run() {
			const handler = commands.get("cursor-usage");
			if (!handler) throw new Error("cursor-usage was not registered");
			await handler("", ctx);
		},
	};
}

function addAgent(owner: CursorSessionOwner, agentInstanceId: string, agentId: string, getUsage: SDKAgent["getUsage"]) {
	const key = runtimeKey(owner.scopeKey, agentInstanceId);
	runtimeTestUtils.slots.set(key, {
		key,
		owner,
		scopeKey: owner.scopeKey,
		agentInstanceId,
		cwd: owner.cwd,
		agent: { agentId, getUsage } as SDKAgent,
		sendState: emptySendState(),
		bindingState: "dirty",
		storeIdentity: { version: 1, stateRoot: "/tmp/usage-test-state" },
	});
}

describe("SDK usage reports", () => {
	test("uses agent totals rather than summing listed turns and preserves fractional cents", () => {
		const usage = usageSnapshot();
		const report = reportFromAgentUsage("agent-1", "main", usage, queriedAt);
		expect(report).toEqual({
			agentId: "agent-1",
			agentInstanceId: "main",
			tokens: usage.usage,
			billing: { status: "reported", rawUsd: 123.456 / 100, chargedUsd: 45.678 / 100 },
			detailCount: 1,
			queriedAt,
		});
		const text = formatUsageReport(report);
		expect(text).toContain("agent-1");
		expect(text).toContain("main");
		expect(text).toMatch(/input\D+111/i);
		expect(text).toMatch(/output\D+22/i);
		expect(text).toMatch(/cache\s*read\D+33/i);
		expect(text).toMatch(/cache\s*write\D+44/i);
		expect(text).toMatch(/total\D+210/i);
		expect(text).toMatch(/raw[^\n]*\$1\.2346/i);
		expect(text).toMatch(/charged[^\n]*\$0\.4568/i);
		expect(text).toContain(new Date(queriedAt).toISOString());
		expect(text).toMatch(/listed[^\n]*\b1\b|\b1\b[^\n]*listed/i);
		const combined = formatUsageReports([report]);
		expect(combined).toMatch(/current SDK agents/i);
		expect(combined).toMatch(/not[^\n]*invoice/i);
		expect(combined).toMatch(/agent totals can exceed listed turns/i);
	});

	test("missing top-level cost remains pending even when listed turns report cost", () => {
		const usage = usageSnapshot();
		delete usage.cost;
		const report = reportFromAgentUsage("agent-1", "main", usage, queriedAt);
		expect(report.billing).toEqual({ status: "pending" });
		const text = formatUsageReport(report);
		expect(text).toMatch(/not reported yet/i);
		expect(text).not.toMatch(/\$\d/);
	});

	test("zero charged cost is reported rather than pending", () => {
		const usage = usageSnapshot();
		usage.cost = { rawCostCents: 12.345, chargedCents: 0 };
		const report = reportFromAgentUsage("agent-1", "main", usage, queriedAt);
		expect(report.billing).toEqual({ status: "reported", rawUsd: 12.345 / 100, chargedUsd: 0 });
		const text = formatUsageReport(report);
		expect(text).toMatch(/raw[^\n]*\$0\.1235/i);
		expect(text).toMatch(/charged[^\n]*\$0\.0000/i);
		expect(text).not.toMatch(/pending|unknown|not reported yet/i);
	});
});

describe("cursor-usage command", () => {
	beforeEach(() => {
		runtimeTestUtils.clear();
		scopeTestUtils.reset();
		commandTestUtils.setGetUsageById(async () => { throw new Error("Unexpected static usage query"); });
	});

	afterEach(() => {
		runtimeTestUtils.clear();
		commandTestUtils.reset();
		scopeTestUtils.reset();
	});

	test("queries every current instance, excludes another owner, and replaces repeated snapshots", async () => {
		const host = createHost();
		const usage = usageSnapshot();
		addAgent(host.owner, "main", "agent-main", async () => usage);
		addAgent(host.owner, "worker", "agent-worker", async () => ({ ...usage, cost: undefined }));
		const otherOwner = ownerForRequest("other-session", host.owner.cwd);
		addAgent(otherOwner, "main", "agent-other", async () => usage);

		await withCursorSessionOwner(otherOwner, () => host.run());
		await withCursorSessionOwner(otherOwner, () => host.run());
		expect(host.notifications).toHaveLength(2);
		for (const notice of host.notifications) {
			expect(notice.type).toBe("info");
			expect(notice.message).toContain("agent-main");
			expect(notice.message).toContain("agent-worker");
			expect(notice.message).not.toContain("agent-other");
			expect(notice.message).toMatch(/not reported yet/i);
			expect(notice.message).toMatch(/raw[^\n]*\$1\.2346/i);
			expect(notice.message).toMatch(/charged[^\n]*\$0\.4568/i);
			expect(notice.message).toMatch(/total\D+210/i);
		}
		expect(host.notifications[1]!.message.match(/\$\d+\.\d+/g)).toEqual(host.notifications[0]!.message.match(/\$\d+\.\d+/g));
	});

	test("one failed agent does not hide successful reports", async () => {
		const host = createHost();
		addAgent(host.owner, "main", "agent-failed", async () => { throw new Error("billing unavailable"); });
		addAgent(host.owner, "worker", "agent-good", async () => usageSnapshot());
		await host.run();
		expect(host.notifications).toHaveLength(1);
		expect(host.notifications[0]!.type).toBe("info");
		expect(host.notifications[0]!.message).toContain("agent-failed");
		expect(host.notifications[0]!.message).toMatch(/billing unavailable/i);
		expect(host.notifications[0]!.message).toContain("agent-good");
		expect(host.notifications[0]!.message).toContain("$0.4568");
	});

	test("all getUsage failures notify an error without rejecting the command", async () => {
		const host = createHost();
		addAgent(host.owner, "main", "agent-failed", async () => { throw new Error("billing unavailable"); });
		await host.run();
		expect(host.notifications).toHaveLength(1);
		expect(host.notifications[0]!.type).toBe("error");
		expect(host.notifications[0]!.message).toContain("agent-failed");
		expect(host.notifications[0]!.message).toMatch(/billing unavailable/i);
	});

	test("no current agent or resume handle gives an actionable error", async () => {
		const host = createHost();
		await host.run();
		expect(host.notifications).toHaveLength(1);
		expect(host.notifications[0]!.type).toBe("error");
		expect(host.notifications[0]!.message).toMatch(/cursor-sdk|current agent/i);
		expect(host.notifications[0]!.message).not.toContain("Unexpected static usage query");
	});
});
