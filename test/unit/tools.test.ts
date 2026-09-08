import { describe, expect, test } from "bun:test";
import { buildCustomTools, createToolCallDedupe, mapOmpToolName, ToolBridgeError } from "../../src/tools.ts";
import { createFakeHost } from "../helpers/fake-host.ts";

describe("custom tools", () => {
	test("maps unsafe names without collision", () => {
		expect(mapOmpToolName("read")).toBe("read");
		expect(mapOmpToolName("read file")).toBe("omp_read_file");
	});

	test("dedupes by bridgeRunId + toolCallId", async () => {
		const host = createFakeHost();
		const dedupe = createToolCallDedupe("run-1");
		const first = await dedupe.execute("call-1", "read", { path: "a.ts" }, () =>
			host.executeTool("read", { path: "a.ts" }, "call-1"),
		);
		const second = await dedupe.execute("call-1", "read", { path: "a.ts" }, () => {
			throw new Error("should not run twice");
		});
		expect(second).toEqual(first);
		expect(host.calls).toHaveLength(1);
	});

	test("rejects missing toolCallId", async () => {
		const dedupe = createToolCallDedupe("run-1");
		await expect(dedupe.execute(undefined, "read", {}, async () => ({ content: [], isError: false }))).rejects.toBeInstanceOf(
			ToolBridgeError,
		);
	});

	test("rejects conflicting replay of the same id", async () => {
		const host = createFakeHost();
		const dedupe = createToolCallDedupe("run-1");
		await dedupe.execute("call-1", "read", { path: "a.ts" }, () => host.executeTool("read", { path: "a.ts" }, "call-1"));
		await expect(
			dedupe.execute("call-1", "read", { path: "b.ts" }, () => host.executeTool("read", { path: "b.ts" }, "call-1")),
		).rejects.toBeInstanceOf(ToolBridgeError);
	});

	test("does not grant write when the snapshot has only read", async () => {
		const host = createFakeHost({ tools: ["read"] });
		const tools = buildCustomTools(host.snapshot().grantedTools, (name, args, toolCallId) => host.executeTool(name, args, toolCallId), createToolCallDedupe("run-1"));
		expect(Object.keys(tools)).toEqual(["read"]);
		await expect(host.executeTool("write", { path: "x" }, "call-x")).rejects.toThrow(/not granted/);
	});
});
