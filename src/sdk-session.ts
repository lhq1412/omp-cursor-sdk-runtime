import "./sdk-exit-guard.js";
import { Agent, JsonlLocalAgentStore, type AgentOptions, type LocalAgentStore, type ModelSelection, type SDKAgent, type SDKCustomTool } from "@cursor/sdk";
import { SDK_NATIVE_DISALLOWED_TOOLS } from "./constants.js";

export const SYSTEM_PROMPT_UNSUPPORTED_ERROR = /unknown option '--system-prompt'/i;

export class CloudAgentRejectedError extends Error {
	constructor(agentId: string) {
		super(`This provider supports local agents only (rejected ${agentId})`);
		this.name = "CloudAgentRejectedError";
	}
}

export interface OpenAgentInput {
	apiKey: string;
	cwd: string;
	model: ModelSelection;
	store: LocalAgentStore;
	customTools: Record<string, SDKCustomTool>;
	savedAgentId?: string;
}

export function assertLocalAgentId(agentId: string | undefined): void {
	if (agentId?.startsWith("bc-")) {
		throw new CloudAgentRejectedError(agentId);
	}
}

export function buildAgentOptions(input: OpenAgentInput): AgentOptions {
	assertLocalAgentId(input.savedAgentId);
	const hasTools = Object.keys(input.customTools).length > 0;
	// Capability gap: omit systemPrompt. The live CLI rejects `--system-prompt`.
	return {
		apiKey: input.apiKey,
		model: input.model,
		tools: hasTools ? ["mcp"] : [],
		disallowedTools: [...SDK_NATIVE_DISALLOWED_TOOLS],
		mcpServers: {},
		local: {
			cwd: input.cwd,
			store: input.store,
			settingSources: [],
			customTools: input.customTools,
			enableAgentRetries: false,
		},
	};
}

export function openJsonlStore(rootDir: string): LocalAgentStore {
	return new JsonlLocalAgentStore(rootDir);
}

export async function openAgent(input: OpenAgentInput): Promise<SDKAgent> {
	const options = buildAgentOptions(input);
	return input.savedAgentId ? Agent.resume(input.savedAgentId, options) : Agent.create(options);
}
