import { describe, expect, test } from "bun:test";
import { alreadyExecuted, createSharedToolExec } from "../../src/host-exec.ts";
import { buildCustomTools, buildToolContract, ToolBridgeError } from "../../src/tools.ts";
import { createFakeHost } from "../helpers/fake-host.ts";

describe("shared tool exec", () => {
	test("executes a granted tool once and marks it already executed", async () => {
		const host = createFakeHost({ tools: ["read"] });
		const exec = createSharedToolExec(
			host.snapshot().grantedTools,
			(name, args, toolCallId) => host.executeTool(name, args, toolCallId),
			"run-1",
		);
		const first = await exec.execute("read", { path: "a.ts" }, "call-1");
		const second = await exec.execute("read", { path: "a.ts" }, "call-1");
		expect(second).toEqual(first);
		expect(host.calls).toHaveLength(1);
		expect(alreadyExecuted(exec, "call-1")).toBe(true);
	});

	test("does not grant write when the snapshot only has read", async () => {
		const host = createFakeHost({ tools: ["read"] });
		const exec = createSharedToolExec(
			host.snapshot().grantedTools,
			(name, args, toolCallId) => host.executeTool(name, args, toolCallId),
			"run-1",
		);
		await expect(exec.execute("write", { path: "x" }, "call-x")).rejects.toBeInstanceOf(ToolBridgeError);
		expect(host.calls).toHaveLength(0);
		const tools = buildCustomTools(buildToolContract(host.snapshot().grantedTools), exec.execute);
		expect(Object.keys(tools)).toEqual(["read"]);
	});

	test("buildCustomTools through SharedToolExec enters dedupe once per callback and executes once", async () => {
		let hostRuns = 0;
		const granted = [{ name: "read", description: "read", inputSchema: { type: "object" } }];
		const exec = createSharedToolExec(
			granted,
			async () => {
				hostRuns += 1;
				return { content: [{ type: "text", text: "ok" }], isError: false };
			},
			"run-1",
		);
		let dedupeEntries = 0;
		const rawExecute = exec.dedupe.execute.bind(exec.dedupe);
		exec.dedupe.execute = (toolCallId, name, args, run) => {
			dedupeEntries += 1;
			return rawExecute(toolCallId, name, args, run);
		};
		const tools = buildCustomTools(buildToolContract(granted), exec.execute);
		await tools.read.execute({ path: "a.ts" }, { toolCallId: "call-1" });
		expect(dedupeEntries).toBe(1);
		expect(hostRuns).toBe(1);
		await tools.read.execute({ path: "a.ts" }, { toolCallId: "call-1" });
		expect(dedupeEntries).toBe(2);
		expect(hostRuns).toBe(1);
	});

	test("failed execution does not re-run the host on same-id reentry", async () => {
		let hostRuns = 0;
		const granted = [{ name: "read", description: "read", inputSchema: { type: "object" } }];
		const exec = createSharedToolExec(
			granted,
			async () => {
				hostRuns += 1;
				throw new Error("host boom");
			},
			"run-1",
		);
		const tools = buildCustomTools(buildToolContract(granted), exec.execute);
		await expect(tools.read.execute({ path: "a.ts" }, { toolCallId: "call-fail" })).rejects.toThrow(/host boom/);
		await expect(tools.read.execute({ path: "a.ts" }, { toolCallId: "call-fail" })).rejects.toThrow(/host boom/);
		expect(hostRuns).toBe(1);
	});

	test("sync throw after registration does not re-run the host on same-id reentry", async () => {
		let hostRuns = 0;
		const granted = [{ name: "read", description: "read", inputSchema: { type: "object" } }];
		const exec = createSharedToolExec(
			granted,
			() => {
				hostRuns += 1;
				throw new Error("sync boom");
			},
			"run-1",
		);
		const tools = buildCustomTools(buildToolContract(granted), exec.execute);
		await expect(tools.read.execute({ path: "a.ts" }, { toolCallId: "call-sync" })).rejects.toThrow(/sync boom/);
		await expect(tools.read.execute({ path: "a.ts" }, { toolCallId: "call-sync" })).rejects.toThrow(/sync boom/);
		expect(hostRuns).toBe(1);
	});

	test("different toolCallIds with identical arguments execute separately", async () => {
		let hostRuns = 0;
		const granted = [{ name: "read", description: "read", inputSchema: { type: "object" } }];
		const exec = createSharedToolExec(
			granted,
			async () => {
				hostRuns += 1;
				return { content: [{ type: "text", text: "ok" }], isError: false };
			},
			"run-1",
		);
		const tools = buildCustomTools(buildToolContract(granted), exec.execute);
		await tools.read.execute({ path: "a.ts" }, { toolCallId: "call-a" });
		await tools.read.execute({ path: "a.ts" }, { toolCallId: "call-b" });
		expect(hostRuns).toBe(2);
	});

	test("isolates identical toolCallIds across bridge runs", async () => {
		let hostRuns = 0;
		const granted = [{ name: "read", description: "read", inputSchema: { type: "object" } }];
		const run = async () => {
			hostRuns += 1;
			return { content: [{ type: "text", text: "ok" }], isError: false };
		};
		const first = createSharedToolExec(granted, run, "run-a");
		const second = createSharedToolExec(granted, run, "run-b");
		await first.execute("read", { path: "a.ts" }, "call-1");
		await second.execute("read", { path: "a.ts" }, "call-1");
		expect(hostRuns).toBe(2);
	});
});
