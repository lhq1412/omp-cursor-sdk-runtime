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
 * Grant-only, once-only tool execution. The `already executed` marker is
 * `bridgeRunId + toolCallId`; a second call with the same id returns the first
 * result and never reaches the host/park callback again.
 */
export function createSharedToolExec(
	grantedTools: readonly GrantedTool[],
	run: ToolExecutor,
	bridgeRunId: string,
): SharedToolExec {
	const grantedNames = new Set(grantedTools.map((tool) => tool.name));
	const dedupe = createToolCallDedupe(bridgeRunId);
	const executed = new Set<string>();
	return {
		bridgeRunId,
		dedupe,
		grantedNames,
		executed,
		execute: async (name, args, toolCallId) => {
			if (!grantedNames.has(name)) {
				throw new ToolBridgeError(`tool ${name} is not granted`);
			}
			const result = await dedupe.execute(toolCallId, name, args, () => run(name, args, toolCallId));
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
