import { describe, expect, test } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { prepareTurn, __testUtils as runtimeTestUtils } from "../../src/session-runtime.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";

describe("session runtime", () => {
	test("refuses parked tool results when no in-memory live run exists", async () => {
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		scopeTestUtils.set("/tmp/project", "/tmp/session.jsonl", "sess-1");
		const context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 1,
				},
			],
		} as Context;
		await expect(
			prepareTurn({
				cwd: "/tmp/project",
				agentInstanceId: "main",
				apiKey: "test-key",
				modelId: "composer-2.5",
				context,
				grantedTools: [],
			}),
		).rejects.toThrow(/restarted/);
	});
});
