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

	test("rejects empty grep pattern before parking and composes glob into path", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const tools = buildCustomTools(
			[{ name: "grep", description: "grep", inputSchema: { type: "object", additionalProperties: true } }],
			async (name, args) => {
				calls.push({ name, args });
				return { content: [{ type: "text", text: "ok" }], isError: false };
			},
			createToolCallDedupe("run-1"),
		);
		const missing = await tools.grep.execute({ path: "src" }, { toolCallId: "call-missing" });
		expect(missing).toEqual({
			content: [{ type: "text", text: "grep pattern is required (received an empty pattern)." }],
			isError: true,
		});
		const globOnly = await tools.grep.execute({ pattern: "  ", glob: "*.ts" }, { toolCallId: "call-glob" });
		expect(globOnly).toEqual({
			content: [{
				type: "text",
				text: 'grep pattern is required (received an empty pattern). To list files matching "*.ts", pass a non-empty regex (e.g. ".") and set path to that glob, or use the ls/read tool instead.',
			}],
			isError: true,
		});
		const composed = await tools.grep.execute({ pattern: "foo", path: "src", glob: "*.ts" }, { toolCallId: "call-ok" });
		expect(composed).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
		expect(calls).toEqual([{ name: "grep", args: { pattern: "foo", path: "src/*.ts" } }]);
	});
});
