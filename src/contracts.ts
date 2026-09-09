import type { Context } from "@oh-my-pi/pi-ai";
import { HOST_BRIDGE_VERSION } from "./constants.js";

export type HostAgentKind = "main" | "subagent" | "compact";

export type BindingState = "committed" | "in-flight" | "dirty";

export interface GrantedTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface HostSnapshotV1 {
	sessionId: string;
	agentInstanceId: string;
	branchEpoch: number;
	cwd: string;
	effectiveContext: Context;
	grantedTools: readonly GrantedTool[];
	configFingerprint: string;
	kind: HostAgentKind;
	committedLeafId?: string;
}

export interface HostToolResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError: boolean;
}

export interface SessionBinding {
	version: 1;
	ompSessionId: string;
	agentInstanceId: string;
	branchEpoch: number;
	sdkAgentId: string;
	workspaceIdentity: string;
	credentialScopeId: string;
	configFingerprint: string;
	committedLeafId: string;
	effectiveHistoryDigest: string;
	state: BindingState;
}

export interface OmpHostBridgeV1 {
	version: typeof HOST_BRIDGE_VERSION;
	snapshot(): HostSnapshotV1;
	executeTool(name: string, args: Record<string, unknown>, toolCallId: string): Promise<HostToolResult>;
	flushToolResults(): Promise<void>;
	commitBinding(binding: SessionBinding): Promise<void>;
	signal: AbortSignal;
}

export function isOmpHostBridgeV1(value: unknown): value is OmpHostBridgeV1 {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === HOST_BRIDGE_VERSION &&
		typeof record.snapshot === "function" &&
		typeof record.executeTool === "function" &&
		typeof record.flushToolResults === "function" &&
		typeof record.commitBinding === "function" &&
		record.signal instanceof AbortSignal
	);
}

export function requireHostBridge(value: unknown): OmpHostBridgeV1 {
	if (!isOmpHostBridgeV1(value)) {
		throw new Error(`OMP host bridge v${HOST_BRIDGE_VERSION} is required on stream options`);
	}
	return value;
}

export function readHostBridge(value: unknown): OmpHostBridgeV1 | undefined {
	return isOmpHostBridgeV1(value) ? value : undefined;
}
