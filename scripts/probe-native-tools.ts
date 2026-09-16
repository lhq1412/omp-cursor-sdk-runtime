import "../src/sdk-exit-guard.ts";
import { nativeReadHooked, runWithNativeTools } from "../src/sdk-native-hook.ts";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCursorApiKey } from "../src/auth.ts";
import { DEFAULT_MODEL_ID } from "../src/constants.ts";

if (!nativeReadHooked) throw new Error("native tool hook did not install");

const MARKER = "SYNTHETIC_OMP_NATIVE";
const PI_WRITE_PATH = "native-piwrite-created.txt";
const apiKey = requireCursorApiKey();
const { Agent, JsonlLocalAgentStore } = await import("@cursor/sdk");

const cases: Array<{
	tools: string[];
	prompt: string;
	expectName: string;
	expectArgs?: Record<string, unknown>;
	diskPath?: string;
	expectResponseMarker?: boolean;
}> = [
	{ tools: ["grep"], prompt: "Call grep with pattern SYNTHETIC on marker.txt. Repeat the tool output exactly.", expectName: "grep" },
	{ tools: ["shell"], prompt: "Call the shell/bash tool with command echo ping. Repeat the tool output exactly.", expectName: "bash", expectResponseMarker: true },
	{ tools: ["edit"], prompt: "Use the edit tool to write exactly SYNTHETIC_OMP_NATIVE into marker.txt.", expectName: "write", expectResponseMarker: true },
	{
		tools: ["piWrite"],
		prompt: `Call the piWrite tool exactly once with this exact JSON argument: {"path":"${PI_WRITE_PATH}","content":"${MARKER}"}. Do not use read, edit, shell, grep, glob, ls, or any other tool. Wait for the tool result, then repeat its exact output.`,
		expectName: "write",
		expectArgs: { path: PI_WRITE_PATH, content: MARKER },
		diskPath: PI_WRITE_PATH,
		expectResponseMarker: true,
	},
];

const results: Array<{
	tools: string[];
	ok: boolean;
	created: boolean;
	argsMatch: boolean;
	diskUntouched: boolean;
	response: string;
	calls: Array<{ name: string; args: Record<string, unknown>; toolCallId: string }>;
	status: string;
}> = [];
for (const testCase of cases) {
	const root = await mkdtemp(join(tmpdir(), "cursor-native-tools-"));
	const calls: Array<{ name: string; args: Record<string, unknown>; toolCallId: string }> = [];
	try {
		await writeFile(join(root, "marker.txt"), "should-not-be-returned\n");
		const disallowed = ["read", "grep", "shell", "edit", "glob", "ls", "piWrite", "delete", "task", "webSearch"].filter(
			(name) => !testCase.tools.includes(name),
		);
		const agent = await Agent.create({
			apiKey,
			model: { id: DEFAULT_MODEL_ID },
			tools: testCase.tools,
			disallowedTools: disallowed,
			local: { cwd: root, store: new JsonlLocalAgentStore(join(root, "store")), settingSources: [], customTools: {} },
		});
		const created = true;
		const run = await runWithNativeTools(async (name, args, toolCallId) => {
			calls.push({ name, args, toolCallId });
			return { content: [{ type: "text", text: MARKER }], isError: false };
		}, () => agent.send(testCase.prompt));
		const result = await run.wait();
		const response = result.result ?? "";
		const call = calls.find((item) => item.name === testCase.expectName);
		const argsMatch = testCase.expectArgs === undefined
			|| (call !== undefined && JSON.stringify(call.args) === JSON.stringify(testCase.expectArgs));
		const diskUntouched = testCase.diskPath === undefined || !existsSync(join(root, testCase.diskPath));
		results.push({
			tools: testCase.tools,
			ok: created && call !== undefined && (!testCase.expectResponseMarker || response.includes(MARKER)) && argsMatch && diskUntouched,
			created,
			argsMatch,
			diskUntouched,
			response,
			calls,
			status: result.status,
		});
		await agent[Symbol.asyncDispose]();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
const ok = results.every((item) => item.ok);
console.log(JSON.stringify({ ok, results }, null, 2));
if (!ok) process.exitCode = 1;
