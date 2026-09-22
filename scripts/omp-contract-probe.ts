import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ModelSelection } from "@cursor/sdk";
import { Effort, toolWireSchema, type Context, type Tool } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	UserMessageSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { buildNativeHistory } from "../src/native-history.ts";

const label = (message: string) => `OMP contract: ${message}`;
function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(label(message));
}
function same(actual: unknown, expected: unknown, message: string): void {
	deepStrictEqual(actual, expected, label(message));
}
function record(value: unknown, message: string): Record<string, unknown> {
	invariant(value !== null && typeof value === "object" && !Array.isArray(value), message);
	return value as Record<string, unknown>;
}

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
	dependencies?: Record<string, string>;
};
const ompPackages = [
	"@oh-my-pi/pi-ai",
	"@oh-my-pi/pi-catalog",
	"@oh-my-pi/pi-coding-agent",
	"@oh-my-pi/pi-utils",
] as const;
const versions: Record<string, string> = {};
for (const packageName of ompPackages) {
	const expected = manifest.dependencies?.[packageName];
	invariant(typeof expected === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected), `${packageName} must have an exact manifest version`);
	const installed = JSON.parse(await readFile(new URL(`../node_modules/${packageName}/package.json`, import.meta.url), "utf8")) as { version?: string };
	strictEqual(installed.version, expected, label(`${packageName} installed version must match manifest ${expected}`));
	versions[packageName] = expected;
}

const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
invariant(bundledModel?.id === "claude-sonnet-4-5", "getBundledModel must return the requested bundled model");
invariant(bundledModel.provider === "anthropic" && typeof bundledModel.api === "string", "getBundledModel provider/API shape changed");
invariant(typeof bundledModel.contextWindow === "number" && bundledModel.contextWindow > 0 && typeof bundledModel.maxTokens === "number" && bundledModel.maxTokens > 0, "getBundledModel token-limit shape changed");
strictEqual(Effort.Medium, "medium", label("Effort runtime values changed"));

const providerModel = {
	id: "fixture-model",
	name: "Fixture Model",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
} satisfies ProviderModelConfig;
void providerModel;

const parameters = {
	type: "object",
	properties: { path: { type: "string" } },
	required: ["path"],
	additionalProperties: false,
} as Tool["parameters"];
const wireSchema = toolWireSchema({ name: "fixture", description: "Fixture tool", parameters });
strictEqual(wireSchema.type, "object", label("toolWireSchema must return an object schema"));
same(wireSchema.required, ["path"], "toolWireSchema required fields changed");
invariant(record(wireSchema.properties, "toolWireSchema properties must be readable").path !== undefined, "toolWireSchema dropped the path property");

const history = [
	{ role: "user", content: "fixture user", timestamp: 1 },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "fixture assistant" },
			{ type: "toolCall", id: "fixture:call", name: "read", arguments: { path: "fixture.ts" } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "fixture-model",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "fixture:call",
		toolName: "read",
		content: [{ type: "text", text: "fixture result" }],
		isError: false,
		timestamp: 3,
	},
	{ role: "developer", content: "fixture developer", timestamp: 4 },
	{ role: "assistant", content: [{ type: "text", text: "fixture developer response" }], timestamp: 5 },
] as Context["messages"];
const selection = { id: "composer-2.5" } as ModelSelection;
const native = await buildNativeHistory(history, selection);
const repeated = await buildNativeHistory(history, selection);
strictEqual(repeated.rootBlobId, native.rootBlobId, label("native-history root hash is not stable for identical semantic input"));
const rootBytes = native.blobs.get(native.rootBlobId);
invariant(rootBytes, "native-history root blob is missing from blobStore");
strictEqual(createHash("sha256").update(rootBytes).digest("hex"), native.rootBlobId, label("native-history root hash does not match its bytes"));
for (const [blobId, bytes] of native.blobs) {
	strictEqual(createHash("sha256").update(bytes).digest("hex"), blobId, label(`blobStore entry ${blobId} is not content-addressed`));
}

const state = fromBinary(ConversationStateStructureSchema, rootBytes);
const populatedState = fromBinary(ConversationStateStructureSchema, toBinary(ConversationStateStructureSchema, ConversationStateStructureSchema.create({
	...state,
	summary: new TextEncoder().encode("fixture summary"),
	tokenDetails: { usedTokens: 321, maxTokens: 654 },
})));
strictEqual(new TextDecoder().decode(populatedState.summary), "fixture summary", label("decoded native-history summary is unreadable"));
same([populatedState.tokenDetails?.usedTokens, populatedState.tokenDetails?.maxTokens], [321, 654], "decoded native-history tokenDetails changed");
strictEqual(state.selfSummaryCount, 0, label("decoded native-history selfSummaryCount changed"));

function readBlob(blobId: Uint8Array, owner: string): Uint8Array {
	const key = Buffer.from(blobId).toString("hex");
	const bytes = native.blobs.get(key);
	invariant(bytes, `${owner} references missing blob ${key}`);
	return bytes;
}

const decoder = new TextDecoder();
const rootMessages = state.rootPromptMessagesJson.map((blobId, index) =>
	record(JSON.parse(decoder.decode(readBlob(blobId, `rootPromptMessagesJson[${index}]`))), `rootPromptMessagesJson[${index}] must decode to an object`)
);
const assistantRoot = rootMessages.find((message) => message.role === "assistant" && Array.isArray(message.content) && message.content.some((part) => record(part, "assistant content must be an object").type === "tool-call"));
invariant(assistantRoot && Array.isArray(assistantRoot.content), "native history lost the assistant tool call");
const rootCall = assistantRoot.content.map((part) => record(part, "assistant content must be an object")).find((part) => part.type === "tool-call");
invariant(rootCall && typeof rootCall.toolCallId === "string", "assistant tool call ID is unreadable");
invariant(rootCall.toolCallId !== "fixture:call" && /^[A-Za-z0-9_-]{1,64}$/.test(rootCall.toolCallId), "assistant tool call ID was not projected to the native contract");
const resultRoot = rootMessages.find((message) => message.role === "tool");
invariant(resultRoot && Array.isArray(resultRoot.content), "native history lost the paired tool result");
const rootResult = record(resultRoot.content[0], "tool result content must be an object");
strictEqual(resultRoot.id, rootCall.toolCallId, label("root prompt tool call/result IDs are not paired"));
strictEqual(rootResult.toolCallId, rootCall.toolCallId, label("root prompt tool result content is not paired"));
strictEqual(rootResult.result, "fixture result", label("root prompt tool result text changed"));
invariant(rootMessages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("fixture developer")), "developer message was not preserved as user history");

strictEqual(state.turns.length, 2, label("native-history turn grouping changed"));
const firstTurn = fromBinary(ConversationTurnStructureSchema, readBlob(state.turns[0]!, "turns[0]"));
invariant(firstTurn.turn.case === "agentConversationTurn", "first native-history turn is not an agent turn");
const firstUser = fromBinary(UserMessageSchema, readBlob(firstTurn.turn.value.userMessage, "turns[0].userMessage"));
strictEqual(firstUser.text, "fixture user", label("first native-history user text changed"));
const firstSteps = firstTurn.turn.value.steps.map((blobId, index) => fromBinary(ConversationStepSchema, readBlob(blobId, `turns[0].steps[${index}]`)));
invariant(firstSteps.some((step) => step.message.case === "assistantMessage" && step.message.value.text === "fixture assistant"), "assistant text step was not preserved");
const toolStep = firstSteps.find((step) => step.message.case === "toolCall");
invariant(toolStep?.message.case === "toolCall", "tool call step was not preserved");
const toolCall = toolStep.message.value;
strictEqual(toolCall.toolCallId, rootCall.toolCallId, label("turn and root-prompt tool call IDs diverged"));
invariant(toolCall.tool.case === "mcpToolCall", "fixture custom tool did not decode as an MCP tool call");
strictEqual(toolCall.tool.value.args?.toolCallId, rootCall.toolCallId, label("decoded MCP args lost tool-call pairing"));
invariant(toolCall.tool.value.result?.result.case === "success", "decoded MCP tool result is not successful");
const resultContent = toolCall.tool.value.result.result.value.content[0]?.content;
invariant(resultContent?.case === "text", "decoded MCP tool result text is unreadable");
strictEqual(resultContent.value.text, "fixture result", label("decoded MCP tool result text changed"));

const secondTurn = fromBinary(ConversationTurnStructureSchema, readBlob(state.turns[1]!, "turns[1]"));
invariant(secondTurn.turn.case === "agentConversationTurn", "developer native-history turn is not an agent turn");
const developerUser = fromBinary(UserMessageSchema, readBlob(secondTurn.turn.value.userMessage, "turns[1].userMessage"));
strictEqual(developerUser.text, "fixture developer", label("developer message text changed"));
invariant(secondTurn.turn.value.steps.some((blobId) => {
	const step = fromBinary(ConversationStepSchema, readBlob(blobId, "turns[1].steps"));
	return step.message.case === "assistantMessage" && step.message.value.text === "fixture developer response";
}), "assistant response after developer message was not preserved");

console.log(`OK OMP contracts (${Object.values(versions).join(", ")})`);
