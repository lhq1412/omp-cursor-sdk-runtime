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
