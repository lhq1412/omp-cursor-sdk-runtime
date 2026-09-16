import "../src/sdk-exit-guard.ts";
import { nativeReadHooked, runWithNativeTools } from "../src/sdk-native-hook.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCursorApiKey } from "../src/auth.ts";
import { DEFAULT_MODEL_ID } from "../src/constants.ts";

if (!nativeReadHooked) throw new Error("native tool hook did not install");

const MARKER = "SYNTHETIC_OMP_NATIVE";
const apiKey = requireCursorApiKey();
const { Agent, JsonlLocalAgentStore } = await import("@cursor/sdk");

const cases: Array<{ tools: string[]; prompt: string; expectName: string }> = [
	{ tools: ["grep"], prompt: "Call grep with pattern SYNTHETIC on marker.txt. Repeat the tool output exactly.", expectName: "grep" },
	{ tools: ["shell"], prompt: "Call the shell/bash tool with command echo ping. Repeat the tool output exactly.", expectName: "bash" },
	{ tools: ["edit"], prompt: "Use the edit tool to write exactly SYNTHETIC_OMP_NATIVE into marker.txt.", expectName: "write" },
];

const results: Array<{ tools: string[]; ok: boolean; calls: Array<{ name: string; toolCallId: string }>; status: string }> = [];
for (const testCase of cases) {
	const root = await mkdtemp(join(tmpdir(), "cursor-native-tools-"));
	const calls: Array<{ name: string; toolCallId: string }> = [];
	try {
		await writeFile(join(root, "marker.txt"), "should-not-be-returned\n");
		const disallowed = ["read", "grep", "shell", "edit", "glob", "ls", "delete", "task", "webSearch"].filter(
			(name) => !testCase.tools.includes(name),
		);
		const agent = await Agent.create({
			apiKey,
			model: { id: DEFAULT_MODEL_ID },
			tools: testCase.tools,
			disallowedTools: disallowed,
			local: { cwd: root, store: new JsonlLocalAgentStore(join(root, "store")), settingSources: [], customTools: {} },
		});
		const run = await runWithNativeTools(async (name, _args, toolCallId) => {
			calls.push({ name, toolCallId });
			return { content: [{ type: "text", text: MARKER }], isError: false };
		}, () => agent.send(testCase.prompt));
		const result = await run.wait();
		const text = JSON.stringify(result);
		results.push({
			tools: testCase.tools,
			ok: calls.some((call) => call.name === testCase.expectName) && text.includes(MARKER) && !text.includes("should-not-be-returned"),
			calls,
			status: result.status,
		});
		await agent[Symbol.asyncDispose]();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
console.log(JSON.stringify({ ok: results.every((item) => item.ok), results }, null, 2));
