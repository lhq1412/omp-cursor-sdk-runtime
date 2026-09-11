import { describe, expect, test } from "bun:test";
import { grantedToolsFromContext, trailingToolResults } from "../../src/omp-tools.ts";
import type { Context, Tool } from "@oh-my-pi/pi-ai";

function tool(name: string, extra: Partial<Tool> = {}): Tool {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: { path: { type: "string" } } },
		...extra,
	} as Tool;
}

describe("OMP tools from context", () => {
	test("grants OMP function tools and skips provider-native tools", () => {
		const granted = grantedToolsFromContext({
			messages: [],
			tools: [tool("read"), tool("bash"), tool("computer", { native: { type: "computer" } as Tool["native"] })],
		});
		expect(granted.map((item) => item.name)).toEqual(["read", "bash"]);
		expect(granted[0]?.inputSchema.type).toBe("object");
	});

	test("does not bridge web_search as a custom tool", () => {
		const granted = grantedToolsFromContext({
			messages: [],
			tools: [tool("read"), tool("web_search")],
		});
		expect(granted.map((item) => item.name)).toEqual(["read"]);
	});

	test("appends OMP tool examples to the custom-tool description", () => {
		const granted = grantedToolsFromContext({
			messages: [],
			tools: [
				tool("todo", {
					description: "Manage todos",
					examples: [
						{ caption: "init", call: { op: "init", list: [{ phase: "Smoke", items: ["Probe"] }] } },
						{ caption: "view", call: { op: "view" } },
					],
				}),
			],
		});
		expect(granted[0]?.description).toContain("Manage todos");
		expect(granted[0]?.description).toContain("<examples>");
		expect(granted[0]?.description).toContain('{"op":"init"');
		expect(granted[0]?.description).toContain('{"op":"view"}');
		expect(granted[0]?.description).not.toContain("tasks");
	});

	test("does not re-append examples already present on the description", () => {
		const description = "Manage todos\n\n<examples>\n# view\n<example>\n{\"op\":\"view\"}\n</example>\n</examples>";
		const granted = grantedToolsFromContext({
			messages: [],
			tools: [
				tool("todo", {
					description,
					examples: [{ caption: "init", call: { op: "init", items: ["dup"] } }],
				}),
			],
		});
		expect(granted[0]?.description).toBe(description);
		expect(granted[0]?.description).not.toContain("dup");
	});

	test("collects trailing tool results for park resume", () => {
		const context = {
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "a" }], isError: false, timestamp: 2 },
				{ role: "toolResult", toolCallId: "b", toolName: "read", content: [{ type: "text", text: "b" }], isError: false, timestamp: 3 },
			],
		} as Context;
		expect(trailingToolResults(context).map((result) => result.toolCallId)).toEqual(["a", "b"]);
	});
});
