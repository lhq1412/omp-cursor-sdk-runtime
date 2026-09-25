/**
 * Offline probe: measure formal custom-tool declaration bytes vs compact guidance
 * using the production buildToolContract / buildCustomTools / prepareSendInput path.
 * Not a live model evaluation and not a permanent user-facing switch.
 */
import { createHash } from "node:crypto";
import { buildCustomTools, buildToolContract, estimateFormalToolDefinitionTokens } from "../src/tools.ts";
import { emptySendState, planSend, prepareSendInput, type ModelInputLimits } from "../src/context.ts";
import type { GrantedTool } from "../src/contracts.ts";
import type { Context } from "@oh-my-pi/pi-ai";

const limits: ModelInputLimits = { contextWindow: 200_000, maxTokens: 20_000 };

const sampleTools: GrantedTool[] = [
	{
		name: "read",
		description: "Read a file from the workspace. Prefer this over shelling out to cat.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
			required: ["path"],
		},
	},
	{
		name: "grep",
		description: "Search file contents with a regex pattern across the workspace.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string" },
				path: { type: "string" },
				glob: { type: "string" },
			},
			required: ["pattern"],
		},
	},
	{
		name: "read file",
		description: "Unsafe name that must hash into an omp_* SDK tool name.",
		inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

const contract = buildToolContract(sampleTools);
const customTools = buildCustomTools(contract, async () => ({ content: [{ type: "text", text: "ok" }], isError: false }));
const formalJson = JSON.stringify(
	Object.fromEntries(
		Object.entries(customTools).map(([name, tool]) => [name, { description: tool.description, inputSchema: tool.inputSchema }]),
	),
);
const context = {
	systemPrompt: ["You are an OMP agent. Keep LSP and delegation guidance intact."],
	messages: [{ role: "user", content: "read src/tools.ts", timestamp: 1 }],
} as Context;
const prepared = prepareSendInput(
	planSend(emptySendState(), context),
	context,
	limits,
	"composer-2.5",
	contract.guidance,
	estimateFormalToolDefinitionTokens(contract.definitions),
);

const report = {
	format: "omp-custom-tools-v2",
	fingerprint: contract.fingerprint,
	guidanceBytes: bytes(contract.guidance),
	formalDefinitionBytes: bytes(formalJson),
	formalDefinitionReserveTokens: estimateFormalToolDefinitionTokens(contract.definitions),
	sendTextBytes: bytes(prepared.prompt.text),
	sdkToolNames: Object.keys(customTools).sort(),
	renames: [...contract.ompToSdk.entries()].filter(([omp, sdk]) => omp !== sdk),
	guidanceOmitsDescription: !contract.guidance.includes("Description:"),
	guidanceOmitsSchema: !contract.guidance.includes("Input schema:"),
	guidanceListsNames: contract.definitions.every((tool) => contract.guidance.includes(tool.sdkName)),
	sendIncludesGuidance: prepared.prompt.text.includes(contract.guidance),
	stableHash: createHash("sha256").update(contract.guidance).digest("hex").slice(0, 16),
};

console.log(JSON.stringify(report, null, 2));
if (!report.guidanceOmitsDescription || !report.guidanceOmitsSchema || !report.guidanceListsNames) {
	process.exitCode = 1;
}
