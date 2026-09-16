import "../src/sdk-exit-guard.ts";
import { nativeReadHooked, runWithNativeRead } from "../src/sdk-native-hook.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCursorApiKey } from "../src/auth.ts";
import { DEFAULT_MODEL_ID } from "../src/constants.ts";

if (!nativeReadHooked) throw new Error("native read hook did not install");

const MARKER = "SYNTHETIC_OMP_READ";
const apiKey = requireCursorApiKey();
const { Agent, JsonlLocalAgentStore } = await import("@cursor/sdk");
const root = await mkdtemp(join(tmpdir(), "cursor-native-read-"));
const calls: Array<{ path: string; toolCallId: string }> = [];
try {
	await writeFile(join(root, "marker.txt"), "should-not-be-returned\n");
	const agent = await Agent.create({
		apiKey,
		model: { id: DEFAULT_MODEL_ID },
		tools: ["read"],
		disallowedTools: ["shell", "edit", "grep", "glob", "ls", "delete", "task"],
		local: { cwd: root, store: new JsonlLocalAgentStore(join(root, "store")), settingSources: [], customTools: {} },
	});
	const run = await runWithNativeRead(async (args, toolCallId) => {
		calls.push({ path: String(args.path), toolCallId });
		return { content: [{ type: "text", text: MARKER }], isError: false };
	}, () => agent.send("Call the read tool on marker.txt. Repeat the exact file contents in your reply."));
	const result = await run.wait();
	const text = JSON.stringify(result);
	console.log(JSON.stringify({
		ok: calls.length > 0 && text.includes(MARKER) && !text.includes("should-not-be-returned"),
		calls,
		status: result.status,
	}));
	await agent[Symbol.asyncDispose]();
} finally {
	await rm(root, { recursive: true, force: true });
}
