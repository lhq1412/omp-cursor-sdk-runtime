import "./sdk-exit-guard.js";
import { Agent, JsonlLocalAgentStore, type AgentOptions, type LocalAgentStore, type ModelSelection, type SDKAgent, type SDKCustomTool } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { buildNativeHistory } from "./native-history.js";
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
	includeWebSearch?: boolean;
	savedAgentId?: string;
	bootstrapHistory?: Context["messages"];
	signal?: AbortSignal;
}

export function assertLocalAgentId(agentId: string | undefined): void {
	if (agentId?.startsWith("bc-")) {
		throw new CloudAgentRejectedError(agentId);
	}
}

export function buildAgentOptions(input: OpenAgentInput): AgentOptions {
	assertLocalAgentId(input.savedAgentId);
	const tools: NonNullable<AgentOptions["tools"]> = [];
	if (Object.keys(input.customTools).length > 0) tools.push("mcp");
	if (input.includeWebSearch) tools.push("webSearch");
	// Capability gap: omit systemPrompt. The live CLI rejects `--system-prompt`.
	return {
		apiKey: input.apiKey,
		model: input.model,
		tools,
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

async function disposeFreshAgent(agent: SDKAgent, input: OpenAgentInput): Promise<void> {
	const agentId = agent.agentId;
	let seed;
	try {
		seed = await input.store.agents.get({ agentId });
	} finally {
		await agent[Symbol.asyncDispose]();
	}
	if (!seed || seed.agentId !== agentId || seed.status !== "idle" || seed.latestCheckpoint) {
		throw new Error("Native history requires a fresh idle agent");
	}
	if (seed.activeRunId) {
		const run = await input.store.runs.get({ agentId, runId: seed.activeRunId });
		const current = await input.store.agents.get({ agentId });
		if (!current || current.agentId !== agentId || current.status !== "idle" ||
			current.activeRunId !== seed.activeRunId || current.latestCheckpoint ||
			!run || run.agentId !== agentId || run.runId !== seed.activeRunId ||
			run.status !== "queued" || run.startedAt != null ||
			run.startCheckpointRef || run.latestCheckpointRef) {
			throw new Error("Refusing to cancel an unowned or active initialization run");
		}
		await Agent.cancelRun(run.runId, { cwd: input.cwd, store: input.store });
	}
}

export async function openAgent(input: OpenAgentInput): Promise<SDKAgent> {
	const options = buildAgentOptions(input);
	const { signal, store } = input;
	signal?.throwIfAborted();
	if (input.savedAgentId && input.bootstrapHistory !== undefined) {
		throw new Error("Bootstrap history is only supported for a new agent");
	}
	const history = input.bootstrapHistory?.length
		? await buildNativeHistory(input.bootstrapHistory, input.model)
		: undefined;
	signal?.throwIfAborted();
	let agent: SDKAgent | undefined;
	try {
		agent = input.savedAgentId
			? await Agent.resume(input.savedAgentId, options)
			: await Agent.create(options);
		if (!history) {
			signal?.throwIfAborted();
			return agent;
		}
		const agentId = agent.agentId;
		// Dispose the seed before changing its persisted checkpoint. Only the
		// queued initialization belonging to this freshly created agent is ours.
		const seed = agent;
		agent = undefined;
		await disposeFreshAgent(seed, input);
		signal?.throwIfAborted();
		for (const [blobId, data] of history.blobs) {
			await store.checkpoints.create({ agentId, blobId, data });
			signal?.throwIfAborted();
		}
		const document = await store.agents.get({ agentId });
		signal?.throwIfAborted();
		if (!document || document.agentId !== agentId || document.status !== "idle" ||
			document.activeRunId || document.latestCheckpoint) {
			throw new Error("Agent changed during native history import");
		}
		// Publish only after every child and the content-addressed root exist.
		await store.agents.update({
			agent: { ...document, latestCheckpoint: { schemaVersion: 1, rootBlobId: history.rootBlobId } },
		});
		signal?.throwIfAborted();
		agent = await Agent.resume(agentId, options);
		signal?.throwIfAborted();
		return agent;
	} catch (error) {
		if (agent) {
			if (!input.savedAgentId && !history) await disposeFreshAgent(agent, input);
			else await agent[Symbol.asyncDispose]();
		}
		throw error;
	}
}
