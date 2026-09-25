import { createHash, randomUUID } from "node:crypto";
import type { SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import { sanitizeSchemaForCursor } from "@oh-my-pi/pi-ai";
import type { GrantedTool, HostToolResult } from "./contracts.js";

const SDK_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export class ToolBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolBridgeError";
	}
}

export function mapOmpToolName(name: string): string {
	if (SDK_TOOL_NAME.test(name)) return name;
	return `omp_${createHash("sha256").update(name).digest("hex").slice(0, 60)}`;
}

export function hostResultToSdk(result: HostToolResult): SDKCustomToolResult {
	return {
		content: result.content.length > 0 ? result.content : [{ type: "text", text: "" }],
		isError: result.isError,
	};
}

export function assertJsonSchemaObject(name: string, schema: Record<string, unknown>): void {
	if (schema.type !== "object") {
		throw new ToolBridgeError(`Tool ${name} inputSchema must be a JSON Schema object`);
	}
}
export interface ToolContractDefinition {
	ompName: string;
	sdkName: string;
	description: string;
	inputSchema: SDKCustomTool["inputSchema"];
}

export interface ToolContract {
	definitions: readonly ToolContractDefinition[];
	ompToSdk: ReadonlyMap<string, string>;
	sdkToOmp: ReadonlyMap<string, string>;
	guidance: string;
	fingerprint: string;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function buildToolContract(grantedTools: readonly GrantedTool[]): ToolContract {
	const definitions: ToolContractDefinition[] = [];
	const ompToSdk = new Map<string, string>();
	const sdkToOmp = new Map<string, string>();
	for (const tool of [...grantedTools].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
		if (ompToSdk.has(tool.name)) throw new ToolBridgeError(`duplicate granted tool ${tool.name}`);
		assertJsonSchemaObject(tool.name, tool.inputSchema);
		const inputSchema = sanitizeSchemaForCursor(tool.inputSchema);
		assertJsonSchemaObject(tool.name, inputSchema);
		const sdkName = mapOmpToolName(tool.name);
		const collision = sdkToOmp.get(sdkName);
		if (collision) throw new ToolBridgeError(`granted tools ${collision} and ${tool.name} map to the same SDK name ${sdkName}`);
		const definition = {
			ompName: tool.name,
			sdkName,
			description: tool.description,
			inputSchema: inputSchema as SDKCustomTool["inputSchema"],
		};
		definitions.push(definition);
		ompToSdk.set(tool.name, sdkName);
		sdkToOmp.set(sdkName, tool.name);
	}
	const serializedDefinitions = stableJson(definitions);
	const guidance = [
		"OMP custom tool contract: call only tools granted below through the custom-user-tools namespace.",
		"Policy: OMP validates, approves, executes, and records every call. Native Cursor tools are unavailable. Pass arguments exactly as defined by the OMP schema; do not translate them to Cursor-native tool arguments.",
		"Granted SDK tool names:",
		...definitions.map((tool) => (
			tool.sdkName === tool.ompName
				? `- ${tool.sdkName}`
				: `- ${tool.sdkName} (OMP name: ${tool.ompName})`
		)),
	].join("\n");
	return {
		definitions,
		ompToSdk,
		sdkToOmp,
		guidance,
		fingerprint: createHash("sha256").update(`omp-custom-tools-v2\0${serializedDefinitions}\0${guidance}`).digest("hex"),
	};
}

/** Conservative input-budget reserve for formal custom-tool declarations (not SDK-exact tokens). */
export function estimateFormalToolDefinitionTokens(definitions: readonly ToolContractDefinition[]): number {
	return (Buffer.byteLength(stableJson(definitions), "utf8") + 3) >> 2;
}


export interface ToolCallDedupe {
	execute(toolCallId: string | undefined, name: string, args: Record<string, unknown>, run: (args: Record<string, unknown>) => Promise<HostToolResult>): Promise<HostToolResult>;
}

export function snapshotJsonObject(value: unknown): { json: string; snapshot: Record<string, unknown> } {
	const json = JSON.stringify(value);
	if (typeof json !== "string") throw new ToolBridgeError("tool arguments are not JSON-serializable");
	const parsed: unknown = JSON.parse(json);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ToolBridgeError("tool arguments are not a JSON object");
	}
	return { json, snapshot: parsed as Record<string, unknown> };
}

/** Dedupes one SDK custom-tool callback by SDK-native toolCallId, not the OMP projection. */
export function createToolCallDedupe(bridgeRunId: string): ToolCallDedupe {
	const inflight = new Map<string, { name: string; argsJson: string; promise: Promise<HostToolResult> }>();
	const completed = new Map<string, { name: string; argsJson: string; result: HostToolResult }>();

	return {
		async execute(toolCallId, name, args, run) {
			if (!toolCallId) {
				throw new ToolBridgeError("custom tool callback is missing toolCallId");
			}
			const key = `${bridgeRunId}:${toolCallId}`;
			const { json: argsJson, snapshot } = snapshotJsonObject(args);
			const previous = completed.get(key);
			if (previous) {
				if (previous.name !== name || previous.argsJson !== argsJson) {
					throw new ToolBridgeError(`duplicate toolCallId ${toolCallId} with conflicting name or arguments`);
				}
				return previous.result;
			}
			const pending = inflight.get(key);
			if (pending) {
				if (pending.name !== name || pending.argsJson !== argsJson) {
					throw new ToolBridgeError(`duplicate toolCallId ${toolCallId} with conflicting name or arguments`);
				}
				return pending.promise;
			}
			// Register before run so sync throws and async rejects still join; never delete on failure.
			const next = Promise.resolve()
				.then(() => run(snapshot))
				.then((result) => {
					completed.set(key, { name, argsJson, result });
					inflight.delete(key);
					return result;
				});
			inflight.set(key, { name, argsJson, promise: next });
			return next;
		},
	};
}

export type ToolExecutor = (
	name: string,
	args: Record<string, unknown>,
	toolCallId: string,
) => Promise<HostToolResult>;

export function buildCustomTools(
	contract: ToolContract,
	execute: ToolExecutor,
): Record<string, SDKCustomTool> {
	const tools: Record<string, SDKCustomTool> = {};
	for (const tool of contract.definitions) {
		tools[tool.sdkName] = {
			description: tool.description,
			inputSchema: tool.inputSchema,
			async execute(args, context) {
				if (!context.toolCallId) {
					throw new ToolBridgeError("custom tool callback is missing toolCallId");
				}
				const prepared = asRecord(args);
				const result = await execute(tool.ompName, prepared, context.toolCallId);
				return hostResultToSdk(result);
			},
		};
	}
	return tools;
}

export function newBridgeRunId(): string {
	return randomUUID();
}
function asRecord(value: unknown): Record<string, unknown> {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	throw new ToolBridgeError("tool arguments are not a JSON object");
}

