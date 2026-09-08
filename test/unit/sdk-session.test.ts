import { describe, expect, test } from "bun:test";
import { SDK_NATIVE_DISALLOWED_TOOLS, SYSTEM_PROMPT_REPLACEMENT } from "../../src/constants.ts";
import { buildAgentOptions, CloudAgentRejectedError } from "../../src/sdk-session.ts";
import { JsonlLocalAgentStore } from "@cursor/sdk";

describe("buildAgentOptions", () => {
	const store = new JsonlLocalAgentStore("/tmp/omp-cursor-runtime-test-store");

	test("uses mcp for custom tools and disallows native executors", () => {
		const options = buildAgentOptions({
			apiKey: "test-key",
			cwd: "/tmp",
			model: { id: "composer-2.5" },
			store,
			customTools: {
				read: {
					description: "read",
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				},
			},
		});
		expect(options.tools).toEqual(["mcp"]);
		expect(options.disallowedTools).toEqual([...SDK_NATIVE_DISALLOWED_TOOLS]);
		expect(options.local?.settingSources).toEqual([]);
		expect(options.local?.enableAgentRetries).toBe(false);
		expect(options.mcpServers).toEqual({});
		expect(options.systemPrompt).toBeUndefined();
		expect(SYSTEM_PROMPT_REPLACEMENT).toBe("unsupported");
	});

	test("uses text-only tools when no custom tools are granted", () => {
		const options = buildAgentOptions({
			apiKey: "test-key",
			cwd: "/tmp",
			model: { id: "composer-2.5" },
			store,
			customTools: {},
		});
		expect(options.tools).toEqual([]);
	});

	test("rejects cloud agent ids", () => {
		expect(() =>
			buildAgentOptions({
				apiKey: "test-key",
				cwd: "/tmp",
				model: { id: "composer-2.5" },
				store,
				customTools: {},
				savedAgentId: "bc-cloud",
			}),
		).toThrow(CloudAgentRejectedError);
	});
});
