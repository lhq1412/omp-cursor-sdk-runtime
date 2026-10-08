import type { Tool, ToolCall } from "@oh-my-pi/pi-ai";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import type { GrantedTool, HostToolResult } from "./contracts.js";
import { createToolCallDedupe, ToolBridgeError, type ToolCallDedupe, type ToolExecutor } from "./tools.js";

export interface SharedToolExec {
	bridgeRunId: string;
	dedupe: ToolCallDedupe;
	grantedNames: ReadonlySet<string>;
	executed: ReadonlySet<string>;
	execute: ToolExecutor;
}

/**
 * Grant-only, once-only tool execution. The execution key is
 * `bridgeRunId + sdkToolCallId`; that SDK-native id maps to one immutable name, arguments, and result.
 * Same payload returns the first result without reaching the host/park callback again.
 * A conflicting name or arguments throws ToolBridgeError, including while the first call is inflight.
 */
function bridgeError(error: unknown): ToolBridgeError {
	if (error instanceof ToolBridgeError) return error;
	return new ToolBridgeError(error instanceof Error ? error.message : String(error));
}

/** Strict schema failure is a bridge error. Lenient tools keep raw args; parsed JSON failures still throw. */
export function validateGrantedArguments(tool: GrantedTool, args: Record<string, unknown>): Record<string, unknown> {
	const call = { type: "toolCall", id: "args", name: tool.name, arguments: args } as ToolCall;
	try {
		const validated = validateToolArguments({
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		} as Tool, call);
		if (validated === null || typeof validated !== "object" || Array.isArray(validated)) {
			throw new ToolBridgeError(`tool ${tool.name} arguments are not a JSON object`);
		}
		return validated as Record<string, unknown>;
	} catch (error) {
		if (!tool.lenientArgValidation) throw bridgeError(error);
		if ("__parseError" in args) throw bridgeError(error);
		const fallback = { ...args };
		delete fallback.__parseError;
		delete fallback.__rawJson;
		return fallback;
	}
}

export function createSharedToolExec(
	grantedTools: readonly GrantedTool[],
	run: ToolExecutor,
	bridgeRunId: string,
): SharedToolExec {
	const grantedByName = new Map(grantedTools.map((tool) => [tool.name, tool]));
	const dedupe = createToolCallDedupe(bridgeRunId);
	const executed = new Set<string>();
	return {
		bridgeRunId,
		dedupe,
		grantedNames: new Set(grantedByName.keys()),
		executed,
		execute: async (name, args, toolCallId) => {
			const granted = grantedByName.get(name);
			if (!granted) {
				throw new ToolBridgeError(`tool ${name} is not granted`);
			}
			const result = await dedupe.execute(toolCallId, name, args, (snapshot) =>
				run(name, validateGrantedArguments(granted, snapshot), toolCallId));
			executed.add(`${bridgeRunId}:${toolCallId}`);
			return result;
		},
	};
}

export function alreadyExecuted(exec: SharedToolExec, toolCallId: string): boolean {
	return exec.executed.has(`${exec.bridgeRunId}:${toolCallId}`);
}

export function asHostResult(text: string, isError = false): HostToolResult {
	return { content: [{ type: "text", text }], isError };
}
