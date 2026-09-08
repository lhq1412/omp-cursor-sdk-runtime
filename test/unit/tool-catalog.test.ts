import { describe, expect, test } from "bun:test";
import {
	__testUtils as catalogTestUtils,
	mergeGrantedTools,
	snapshotHostToolCatalog,
} from "../../src/tool-catalog.ts";
import { grantedToolsFromContext } from "../../src/omp-tools.ts";
import { uniqueSdkToolName } from "../../src/tools.ts";
import type { Tool } from "@oh-my-pi/pi-ai";

function tool(name: string): Tool {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} },
	} as Tool;
}

describe("host tool catalog", () => {
	test("adds xd://-mounted MCP tools even when they appear in getEnabledToolNames", () => {
		catalogTestUtils.clear();
		snapshotHostToolCatalog([
			"read",
			"bash",
			{
				name: "mcp__github_list_issues",
				description: "List GitHub issues",
				parameters: { type: "object", properties: { repo: { type: "string" } } },
			},
			"mcp__exa_search",
		]);
		const granted = mergeGrantedTools(
			grantedToolsFromContext({ messages: [], tools: [tool("read"), tool("bash")] }),
		);
		expect(granted.map((item) => item.name)).toEqual(["read", "bash", "mcp__github_list_issues", "mcp__exa_search"]);
		const github = granted.find((item) => item.name === "mcp__github_list_issues");
		expect(github?.description).toContain("MCP");
		expect(github?.inputSchema).toMatchObject({ type: "object", properties: { repo: { type: "string" } } });
	});

	test("does not override schemas already present in context.tools", () => {
		catalogTestUtils.clear();
		snapshotHostToolCatalog(["read", "mcp__dup"]);
		const granted = mergeGrantedTools([
			{ name: "mcp__dup", description: "from context", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
		]);
		expect(granted.find((item) => item.name === "mcp__dup")?.description).toBe("from context");
		expect(granted.find((item) => item.name === "mcp__dup")?.inputSchema).toEqual({
			type: "object",
			properties: { q: { type: "string" } },
		});
	});

	test("refreshes from a live catalog at merge time so late MCP connects are visible", () => {
		catalogTestUtils.clear();
		catalogTestUtils.setLiveCatalog(() => [
			{ name: "mcp__late_connect", description: "connected after session_start", parameters: { type: "object" } },
		]);
		const granted = mergeGrantedTools(grantedToolsFromContext({ messages: [], tools: [tool("read")] }));
		expect(granted.map((item) => item.name)).toContain("mcp__late_connect");
	});

	test("maps long MCP names to unique SDK identifiers", () => {
		const used = new Set<string>();
		const first = uniqueSdkToolName("mcp__a_very_long_server_name_and_an_even_longer_tool_name_exceeding_limit", used);
		const second = uniqueSdkToolName("mcp__a_very_long_server_name_and_an_even_longer_tool_name_exceeding_limit_2", used);
		expect(first).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
		expect(second).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
		expect(first).not.toBe(second);
	});
});
