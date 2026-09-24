import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildCustomTools, buildToolContract, createToolCallDedupe, mapOmpToolName, ToolBridgeError } from "../../src/tools.ts";
import { createFakeHost } from "../helpers/fake-host.ts";

function hashedSdkName(name: string): string {
	return `omp_${createHash("sha256").update(name).digest("hex").slice(0, 60)}`;
}

describe("custom tools", () => {
	test("maps safe names through and hashes unsafe names deterministically", () => {
		expect(mapOmpToolName("read")).toBe("read");
		expect(mapOmpToolName("mcp__server_tool")).toBe("mcp__server_tool");
		expect(mapOmpToolName("read file")).toBe(hashedSdkName("read file"));
		expect(mapOmpToolName("read file")).toBe(mapOmpToolName("read file"));
		expect(mapOmpToolName("read file")).not.toBe(mapOmpToolName("read\tfile"));
	});

	test("buildToolContract sorts canonically and fingerprints/guidance stay stable", () => {
		const granted = [
			{ name: "write", description: "write", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
			{ name: "read file", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
			{ name: "read", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
		] as const;
		const first = buildToolContract(granted);
		const second = buildToolContract([...granted].reverse());
		expect(first.definitions.map((tool) => tool.ompName)).toEqual(["read", "read file", "write"]);
		expect(first.definitions.map((tool) => tool.sdkName)).toEqual(["read", hashedSdkName("read file"), "write"]);
		expect(first.fingerprint).toBe(second.fingerprint);
		expect(first.guidance).toBe(second.guidance);
		expect(first.guidance).toContain("SDK name: read");
		expect(first.guidance).toContain(`SDK name: ${hashedSdkName("read file")}`);
		expect(first.guidance).toContain("OMP name: read file");
		expect(first.guidance).toContain("Pass arguments exactly as defined by the OMP schema");
		expect(first.ompToSdk.get("read file")).toBe(hashedSdkName("read file"));
		expect(first.sdkToOmp.get(hashedSdkName("read file"))).toBe("read file");
	});

	test("fails closed on invalid or colliding schemas", () => {
		expect(() => buildToolContract([{ name: "bad", description: "bad", inputSchema: { type: "array" } }])).toThrow(ToolBridgeError);
		expect(() => buildToolContract([
			{ name: "read", description: "a", inputSchema: { type: "object" } },
			{ name: "read", description: "b", inputSchema: { type: "object" } },
		])).toThrow(/duplicate granted tool read/);
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

	test("joins inflight same payload and rejects inflight conflict", async () => {
		const dedupe = createToolCallDedupe("run-1");
		const gate = Promise.withResolvers<{ content: Array<{ type: "text"; text: string }>; isError: boolean }>();
		let runs = 0;
		const first = dedupe.execute("call-1", "read", { path: "a.ts" }, async () => {
			runs += 1;
			return gate.promise;
		});
		const same = dedupe.execute("call-1", "read", { path: "a.ts" }, async () => {
			runs += 1;
			throw new Error("should not run twice");
		});
		await expect(
			dedupe.execute("call-1", "read", { path: "b.ts" }, async () => {
				runs += 1;
				throw new Error("should not run args conflict");
			}),
		).rejects.toBeInstanceOf(ToolBridgeError);
		await expect(
			dedupe.execute("call-1", "grep", { pattern: "x" }, async () => {
				runs += 1;
				throw new Error("should not run name conflict");
			}),
		).rejects.toBeInstanceOf(ToolBridgeError);
		const result = { content: [{ type: "text", text: "ok" }], isError: false };
		gate.resolve(result);
		expect(await first).toEqual(result);
		expect(await same).toEqual(result);
		expect(runs).toBe(1);
	});

	test("does not grant write when the snapshot has only read", async () => {
		const host = createFakeHost({ tools: ["read"] });
		const tools = buildCustomTools(
			buildToolContract(host.snapshot().grantedTools),
			(name, args, toolCallId) => host.executeTool(name, args, toolCallId),
			createToolCallDedupe("run-1"),
		);
		expect(Object.keys(tools)).toEqual(["read"]);
		await expect(host.executeTool("write", { path: "x" }, "call-x")).rejects.toThrow(/not granted/);
	});

	test("passes OMP grep arguments through exactly without rewriting", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const contract = buildToolContract([
			{ name: "grep", description: "grep", inputSchema: { type: "object", additionalProperties: true } },
		]);
		const tools = buildCustomTools(
			contract,
			async (name, args) => {
				calls.push({ name, args });
				return { content: [{ type: "text", text: "ok" }], isError: false };
			},
			createToolCallDedupe("run-1"),
		);
		const empty = await tools.grep.execute({ path: "src" }, { toolCallId: "call-empty" });
		expect(empty).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
		const blankPattern = await tools.grep.execute({ pattern: "  ", glob: "*.ts" }, { toolCallId: "call-blank" });
		expect(blankPattern).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
		const composed = await tools.grep.execute({ pattern: "foo", path: "src", glob: "*.ts" }, { toolCallId: "call-ok" });
		expect(composed).toEqual({ content: [{ type: "text", text: "ok" }], isError: false });
		expect(calls).toEqual([
			{ name: "grep", args: { path: "src" } },
			{ name: "grep", args: { pattern: "  ", glob: "*.ts" } },
			{ name: "grep", args: { pattern: "foo", path: "src", glob: "*.ts" } },
		]);
	});

	test("detaches callback arguments from the SDK object", async () => {
		const source = { path: "a.ts" };
		let seen: Record<string, unknown> | undefined;
		const tools = buildCustomTools(
			buildToolContract([{ name: "read", description: "read", inputSchema: { type: "object" } }]),
			async (_name, args) => {
				seen = args;
				source.path = "mutated";
				return { content: [{ type: "text", text: "ok" }], isError: false };
			},
			createToolCallDedupe("run-1"),
		);
		await tools.read.execute(source, { toolCallId: "call-1" });
		expect(seen).toEqual({ path: "a.ts" });
		expect(seen).not.toBe(source);
	});

	test("does not run a callback when arguments are not a JSON object", async () => {
		let ran = false;
		const tools = buildCustomTools(
			buildToolContract([{ name: "read", description: "read", inputSchema: { type: "object" } }]),
			async () => {
				ran = true;
				return { content: [{ type: "text", text: "ok" }], isError: false };
			},
			createToolCallDedupe("run-1"),
		);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		await expect(tools.read.execute(cyclic, { toolCallId: "call-cyclic" })).rejects.toThrow();
		const boxed = { toJSON: () => 1 };
		await expect(tools.read.execute(boxed, { toolCallId: "call-boxed" })).rejects.toBeInstanceOf(ToolBridgeError);
		expect(ran).toBe(false);
	});

	test("returns exact text and image content from the tool callback", async () => {
		const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
		const tools = buildCustomTools(
			buildToolContract([{ name: "read", description: "read", inputSchema: { type: "object" } }]),
			async () => ({ content: [{ type: "text", text: "caption" }, image], isError: false }),
			createToolCallDedupe("run-1"),
		);
		await expect(tools.read.execute({}, { toolCallId: "call-img" })).resolves.toEqual({
			content: [{ type: "text", text: "caption" }, image],
			isError: false,
		});
	});

	test("projects combinators out of advertised custom-tool schemas", () => {
		const tools = buildCustomTools(
			buildToolContract([{
				name: "eval",
				description: "eval",
				inputSchema: {
					type: "object",
					properties: { language: { anyOf: [{ type: "string" }, { type: "null" }] } },
				},
			}]),
			async () => ({ content: [], isError: false }),
			createToolCallDedupe("run-1"),
		);
		expect(JSON.stringify(tools.eval.inputSchema)).not.toContain("anyOf");
	});
});
