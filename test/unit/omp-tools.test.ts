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
