import type { GrantedTool, HostSnapshotV1, HostToolResult, OmpHostBridgeV1, SessionBinding } from "../../src/contracts.ts";
import { HOST_BRIDGE_VERSION } from "../../src/constants.ts";

export interface FakeHostOptions {
	tools?: string[];
	cwd?: string;
	sessionId?: string;
	agentInstanceId?: string;
	kind?: HostSnapshotV1["kind"];
	systemPrompt?: string;
}

export function createFakeHost(options: FakeHostOptions = {}): OmpHostBridgeV1 & { calls: Array<{ name: string; args: Record<string, unknown>; toolCallId: string }>; bindings: SessionBinding[] } {
	const names = options.tools ?? ["read"];
	const grantedTools: GrantedTool[] = names.map((name) => ({
		name,
		description: name,
		inputSchema: { type: "object", properties: { path: { type: "string" } } },
	}));
	const controller = new AbortController();
	const calls: Array<{ name: string; args: Record<string, unknown>; toolCallId: string }> = [];
	const bindings: SessionBinding[] = [];
	const granted = new Set(names);

	const host: OmpHostBridgeV1 & { calls: typeof calls; bindings: SessionBinding[] } = {
		version: HOST_BRIDGE_VERSION,
		signal: controller.signal,
		calls,
		bindings,
		snapshot(): HostSnapshotV1 {
			return {
				sessionId: options.sessionId ?? "session-1",
				agentInstanceId: options.agentInstanceId ?? "main",
				branchEpoch: 0,
				cwd: options.cwd ?? process.cwd(),
				effectiveContext: {
					systemPrompt: [options.systemPrompt ?? "You are a test agent."],
					messages: [{ role: "user", content: "hello", timestamp: Date.now() } as HostSnapshotV1["effectiveContext"]["messages"][number]],
				},
				grantedTools,
				configFingerprint: "test",
				kind: options.kind ?? "main",
			};
		},
		async executeTool(name, args, toolCallId): Promise<HostToolResult> {
			if (!granted.has(name)) {
				throw new Error(`tool ${name} is not granted`);
			}
			calls.push({ name, args, toolCallId });
			return { content: [{ type: "text", text: `ok:${name}` }], isError: false };
		},
		async flushToolResults() {},
		async commitBinding(binding) {
			bindings.push(binding);
		},
	};
	return host;
}
