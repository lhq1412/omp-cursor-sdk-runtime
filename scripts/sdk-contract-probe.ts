import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type RunResult } from "@cursor/sdk";
import { DEFAULT_MODEL_ID, SYSTEM_PROMPT_REPLACEMENT } from "../src/constants.ts";
import { requireCursorApiKey } from "../src/auth.ts";
import { buildAgentOptions, openJsonlStore } from "../src/sdk-session.ts";

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

	try {
		const options = buildAgentOptions({
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
		});
		if (options.systemPrompt !== undefined) {
			throw new Error("v1 must not set AgentOptions.systemPrompt");
		}
		results.push({
			name: "systemPrompt",
			ok: SYSTEM_PROMPT_REPLACEMENT === "unsupported",
			detail: "GAP AgentOptions.systemPrompt is omitted; live CLI rejected --system-prompt; OMP system prompt is not forwarded into user send",
		});

		const agent = await Agent.create(options);
		try {
			const run = await agent.send("Call ping with token alpha. Do not use any other tool.");
			const result = await run.wait();
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
				ok: result.status === "finished" && calls.length > 0,
				detail: `custom ping must run; ${formatRun(result, apiKey)}`,
			});

			const resumed = await Agent.resume(agent.agentId, options);
			try {
				const follow = await resumed.send("Reply with the single word OK.");
				const followResult = await follow.wait();
				results.push({
					name: "resume",
					ok: followResult.status === "finished",
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
