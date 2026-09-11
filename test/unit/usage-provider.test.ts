import { afterEach, expect, test } from "bun:test";
import type { AgentUsage, SDKAgent } from "@cursor/sdk";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai";
import { credentialScopeId } from "../../src/auth.ts";
import { emptySendState } from "../../src/context.ts";
import { __testUtils as runtimeTestUtils, runtimeKey } from "../../src/session-runtime.ts";
import { __testUtils as scopeTestUtils, ownerForRequest, withCursorSessionOwner } from "../../src/session-scope.ts";
import { cursorSdkUsageProvider } from "../../src/usage-provider.ts";

const params: UsageFetchParams = { provider: "cursor-sdk", credential: { type: "api_key", apiKey: "crsr_usage-test-key" } };
const context = { fetch: globalThis.fetch };
const totals: AgentUsage = {
	usage: { inputTokens: 111, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, totalTokens: 210 },
	cost: { rawCostCents: 12.345, chargedCents: 0 },
	runs: [{ runId: "listed", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 }, cost: { rawCostCents: 100, chargedCents: 100 } }],
};

function addAgent(session: string, agentId: string, getUsage: SDKAgent["getUsage"], apiKey = params.credential.apiKey!) {
	const owner = ownerForRequest(session, "/tmp/native-usage-test");
	const key = runtimeKey(owner.scopeKey, agentId);
	runtimeTestUtils.slots.set(key, {
		key, owner, scopeKey: owner.scopeKey, agentInstanceId: agentId, cwd: owner.cwd,
		credentialScopeId: credentialScopeId(apiKey),
		agent: { agentId, getUsage } as SDKAgent,
		sendState: emptySendState(), bindingState: "committed",
		storeIdentity: { version: 1, stateRoot: "/tmp/native-usage-test-state" },
	});
	return owner;
}

afterEach(() => {
	runtimeTestUtils.clear();
	scopeTestUtils.reset();
});

test("native usage includes other owners sharing a credential, deduplicates IDs, and never queries other credentials", async () => {
	const calls: string[] = [];
	const owner = addAgent("session-a", "shared", async () => { calls.push("shared"); return totals; });
	addAgent("session-b", "shared", async () => { calls.push("duplicate"); return totals; });
	addAgent("session-b", "other", async () => { calls.push("other"); return totals; });
	addAgent("session-c", "foreign", async () => { calls.push("foreign"); return totals; }, "crsr_foreign");
	const report = await withCursorSessionOwner(owner, () => cursorSdkUsageProvider.fetchUsage(params, context));
	expect(calls).toEqual(["shared", "other"]);
	expect(report!.limits.filter((limit) => limit.amount.unit === "tokens").map((limit) => limit.amount)).toEqual([
		{ used: 210, unit: "tokens" }, { used: 210, unit: "tokens" },
	]);
	// The dashboard groups by label+window: duplicate labels would silently discard an agent.
	expect(new Set(report!.limits.map((limit) => limit.label)).size).toBe(6);
	expect(report!.limits.filter((limit) => limit.amount.unit === "usd").map((limit) => limit.amount)).toEqual([
		{ used: 0.12345, unit: "usd" }, { used: 0, unit: "usd" },
		{ used: 0.12345, unit: "usd" }, { used: 0, unit: "usd" },
	]);
	const outsideOwner = await cursorSdkUsageProvider.fetchUsage(params, context);
	expect(outsideOwner!.limits.map((limit) => limit.amount)).toEqual(report!.limits.map((limit) => limit.amount));
	expect(report!.notes!.join(" ")).toMatch(/across sessions.*not current-session usage, account quota, or a complete invoice/);
});

test("pending agent billing omits USD even when listed runs have costs; partial failures remain visible and sanitized", async () => {
	addAgent("session-a", "pending", async () => ({ ...totals, cost: undefined }));
	addAgent("session-b", "failed", async () => { throw new Error(`failed using ${params.credential.apiKey}`); });
	const report = await cursorSdkUsageProvider.fetchUsage(params, context);
	expect(report!.limits.map((limit) => limit.amount)).toEqual([{ used: 210, unit: "tokens" }]);
	expect(report!.limits[0]!.notes!.join(" ")).toMatch(/billing pending/i);
	expect(report!.notes!.join(" ")).toContain("failed");
	expect(JSON.stringify(report)).not.toContain(params.credential.apiKey!);
});

test("no matching live agents returns null rather than using another credential", async () => {
	let queried = false;
	addAgent("foreign-session", "foreign", async () => { queried = true; return totals; }, "crsr_foreign");
	expect(await cursorSdkUsageProvider.fetchUsage(params, context)).toBeNull();
	expect(queried).toBe(false);
});

test("all failures reject with sanitized diagnostics", async () => {
	addAgent("session-a", "failed", async () => { throw new Error(`unavailable ${params.credential.apiKey}`); });
	try {
		await cursorSdkUsageProvider.fetchUsage(params, context);
		throw new Error("expected usage query to fail");
	} catch (error) {
		expect(String(error)).toContain("unavailable");
		expect(String(error)).not.toContain(params.credential.apiKey!);
	}
});

test("abort stops waiting on SDK usage and prevents subsequent queries without cancelling the agent", async () => {
	const controller = new AbortController();
	const { promise, resolve: release } = Promise.withResolvers<AgentUsage>();
	let secondQueried = false;
	addAgent("session-a", "first", () => promise);
	addAgent("session-b", "second", async () => { secondQueried = true; return totals; });
	const pending = cursorSdkUsageProvider.fetchUsage({ ...params, signal: controller.signal }, context);
	const reason = new Error("cancelled by user");
	controller.abort(reason);
	await expect(pending).rejects.toBe(reason);
	release(totals);
	await Promise.resolve();
	expect(secondQueried).toBe(false);
});

test("already-aborted requests never query SDK agents", async () => {
	let queried = false;
	addAgent("session-a", "first", async () => { queried = true; return totals; });
	const reason = new Error("already cancelled");
	await expect(cursorSdkUsageProvider.fetchUsage({ ...params, signal: AbortSignal.abort(reason) }, context)).rejects.toBe(reason);
	expect(queried).toBe(false);
});
