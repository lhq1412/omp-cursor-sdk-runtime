import { randomUUID } from "node:crypto";
import type { SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import type { GrantedTool, HostToolResult } from "./contracts.js";
import { toolNameHash } from "./tool-catalog.js";

const SDK_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export class ToolBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolBridgeError";
	}
}

export function mapOmpToolName(name: string): string {
	if (SDK_TOOL_NAME.test(name)) return name;
	const mapped = `omp_${name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
	if (SDK_TOOL_NAME.test(mapped)) return mapped;
	return `omp_${toolNameHash(name)}`;
}

export function uniqueSdkToolName(name: string, usedNames: Set<string>): string {
	let mapped = mapOmpToolName(name);
	if (!usedNames.has(mapped)) {
		usedNames.add(mapped);
		return mapped;
	}
	const hashed = `${mapped.slice(0, 55)}_${toolNameHash(name)}`.slice(0, 64);
	let candidate = hashed;
	let counter = 2;
	while (usedNames.has(candidate) || !SDK_TOOL_NAME.test(candidate)) {
		candidate = `omp_${toolNameHash(`${name}:${counter}`)}`;
		counter += 1;
	}
	usedNames.add(candidate);
	return candidate;
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

export interface ToolCallDedupe {
	execute(toolCallId: string | undefined, name: string, args: Record<string, unknown>, run: () => Promise<HostToolResult>): Promise<HostToolResult>;
}

export function createToolCallDedupe(bridgeRunId: string): ToolCallDedupe {
	const inflight = new Map<string, Promise<HostToolResult>>();
	const completed = new Map<string, { name: string; argsJson: string; result: HostToolResult }>();

	return {
		async execute(toolCallId, name, args, run) {
			if (!toolCallId) {
				throw new ToolBridgeError("custom tool callback is missing toolCallId");
			}
			const key = `${bridgeRunId}:${toolCallId}`;
			const argsJson = JSON.stringify(args);
			const previous = completed.get(key);
			if (previous) {
				if (previous.name !== name || previous.argsJson !== argsJson) {
					throw new ToolBridgeError(`duplicate toolCallId ${toolCallId} with conflicting name or arguments`);
				}
				return previous.result;
			}
			const pending = inflight.get(key);
			if (pending) return pending;
			const next = run().then((result) => {
				completed.set(key, { name, argsJson, result });
				inflight.delete(key);
				return result;
			});
			inflight.set(key, next);
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
	grantedTools: readonly GrantedTool[],
	execute: ToolExecutor,
	dedupe: ToolCallDedupe,
): Record<string, SDKCustomTool> {
	const usedNames = new Set<string>();
	const tools: Record<string, SDKCustomTool> = {};
	for (const tool of grantedTools) {
		if (tool.inputSchema.type !== "object") continue;
		const sdkName = uniqueSdkToolName(tool.name, usedNames);
		tools[sdkName] = {
			description: tool.description,
			inputSchema: tool.inputSchema as SDKCustomTool["inputSchema"],
			async execute(args, context) {
				const prepared = prepareGrepArgs(tool.name, asRecord(args));
				if ("error" in prepared) {
					return hostResultToSdk({ content: [{ type: "text", text: prepared.error }], isError: true });
				}
				const result = await dedupe.execute(context.toolCallId, tool.name, prepared.args, () =>
					execute(tool.name, prepared.args, context.toolCallId ?? ""),
				);
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
	return {};
}

/** Cursor grepArgs: reject empty pattern before OMP validation; compose path only when glob is set. */
function prepareGrepArgs(name: string, args: Record<string, unknown>): { args: Record<string, unknown> } | { error: string } {
	if (name !== "grep") return { args };
	const pattern = args.pattern;
	const glob = typeof args.glob === "string" ? args.glob : "";
	if (typeof pattern !== "string" || !pattern.trim()) {
		if (glob) {
			return {
				error: `grep pattern is required (received an empty pattern). To list files matching "${glob}", pass a non-empty regex (e.g. ".") and set path to that glob, or use the ls/read tool instead.`,
			};
		}
		return { error: "grep pattern is required (received an empty pattern)." };
	}
	if (!glob) return { args };
	const next: Record<string, unknown> = { ...args, path: `${typeof args.path === "string" && args.path ? args.path : "."}/${glob}` };
	delete next.glob;
	return { args: next };
}
