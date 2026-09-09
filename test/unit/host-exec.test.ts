import { describe, expect, test } from "bun:test";
import { alreadyExecuted, createSharedToolExec } from "../../src/host-exec.ts";
import { buildCustomTools, ToolBridgeError } from "../../src/tools.ts";
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
		const tools = buildCustomTools(host.snapshot().grantedTools, exec.execute, exec.dedupe);
		expect(Object.keys(tools)).toEqual(["read"]);
	});
});
