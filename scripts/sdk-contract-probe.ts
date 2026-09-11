import "../src/sdk-exit-guard.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type RunResult } from "@cursor/sdk";
import { DEFAULT_MODEL_ID, SDK_TOOL_CONTEXT, SYSTEM_PROMPT_REPLACEMENT } from "../src/constants.ts";
import { requireCursorApiKey } from "../src/auth.ts";
import { buildAgentOptions, openAgent, openJsonlStore, type OpenAgentInput } from "../src/sdk-session.ts";

interface ProbeResult {
	name: string;
	ok: boolean;
	detail: string;
}

function scrub(text: string, apiKey: string): string {
	return text.split(apiKey).join("<redacted>");
}

function formatRun(result: RunResult, apiKey: string): string {
	const error = result.error;
	const parts = [
		`status=${result.status}`,
		result.result ? `text=${JSON.stringify(result.result).slice(0, 200)}` : undefined,
		error?.code ? `code=${error.code}` : undefined,
		error?.message ? `error=${scrub(error.message, apiKey)}` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.join(" ");
}

async function main(): Promise<void> {
	const apiKey = requireCursorApiKey();
	const cwd = await mkdtemp(join(tmpdir(), "omp-cursor-runtime-probe-"));
	const store = openJsonlStore(join(cwd, "store"));
	const calls: Array<{ toolCallId?: string; args: Record<string, unknown> }> = [];
	const results: ProbeResult[] = [];
	const historyToken = `native-history-${randomUUID()}`;

	try {
		const input: OpenAgentInput = {
			apiKey,
			cwd,
			model: { id: DEFAULT_MODEL_ID },
			store,
			customTools: {
				ping: {
					description: "Return the provided token. The only tool you may call.",
					inputSchema: {
						type: "object",
						properties: { token: { type: "string" } },
						required: ["token"],
					},
					execute: async (args, context) => {
						calls.push({ toolCallId: context.toolCallId, args });
						return { content: [{ type: "text", text: `pong:${String(args.token ?? "")}` }] };
					},
				},
			},
		};
		const options = buildAgentOptions(input);
		if (options.systemPrompt !== undefined) {
			throw new Error("v1 must not set AgentOptions.systemPrompt");
		}
		results.push({
			name: "systemPrompt",
			ok: SYSTEM_PROMPT_REPLACEMENT === "unsupported",
			detail: "GAP AgentOptions.systemPrompt is omitted; live CLI rejected --system-prompt; the adapter includes sanitized OMP instructions only in bootstrap text, not as native system-role input",
		});

		const agent = await openAgent({
			...input,
			bootstrapHistory: [{ role: "user", content: `Remember this history token: ${historyToken}.`, timestamp: 1 }],
		});
		try {
			const run = await agent.send(`${SDK_TOOL_CONTEXT}\n\nCall ping with token alpha exactly once, then reply with the remembered history token. Do not use any other tool.`);
			const result = await run.wait();
			results.push({
				name: "nativeHistory",
				ok: result.status === "finished" && Boolean(result.result?.includes(historyToken)),
				detail: formatRun(result, apiKey),
			});
			results.push({
				name: "toolCallId",
				ok: result.status === "finished" && calls.some((call) => typeof call.toolCallId === "string" && call.toolCallId.length > 0),
				detail:
					calls.length === 0
						? `ping was not invoked ${formatRun(result, apiKey)}`
						: `ids=${calls.map((c) => c.toolCallId ?? "<missing>").join(",")} ${formatRun(result, apiKey)}`,
			});
			results.push({
				name: "toolRestriction",
				ok: result.status === "finished" && calls.length === 1,
				detail: `custom ping must run exactly once; ${formatRun(result, apiKey)}`,
			});

			const resumed = await Agent.resume(agent.agentId, options);
			try {
				const follow = await resumed.send("Reply with the remembered history token. Do not call any tools.");
				const followResult = await follow.wait();
				results.push({
					name: "resume",
					ok: followResult.status === "finished" && Boolean(followResult.result?.includes(historyToken)) && calls.length === 1,
					detail: `${formatRun(followResult, apiKey)} agentId=${resumed.agentId}`,
				});
			} finally {
				await resumed[Symbol.asyncDispose]();
			}
		} finally {
			await agent[Symbol.asyncDispose]();
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}

	for (const result of results) {
		const label = result.name === "systemPrompt" && result.ok ? "GAP" : result.ok ? "PASS" : "FAIL";
		console.log(`${label} ${result.name}: ${result.detail}`);
	}
	if (results.some((result) => !result.ok)) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(2);
});
