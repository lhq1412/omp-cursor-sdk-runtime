import "./sdk-exit-guard.js";
import { createHash } from "node:crypto";
import type { LocalAgentStore, ModelSelection } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import { ConversationStateStructureSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { nativeToolCallId } from "./context.js";

/** Project history only; the SDK remains responsible for creating and running agents. */
export async function buildNativeHistory(history: Context["messages"], selection: ModelSelection) {
	const callIds = new Set<string>();
	const messages = history.map((message) => {
		if (message.role === "toolResult") return { ...message, toolCallId: nativeToolCallId(message.toolCallId) };
		if (message.role !== "assistant") return message;
		return {
			...message,
			content: message.content.map((block) => {
				if (block.type !== "toolCall") return block;
				if (callIds.has(block.id)) throw new Error("Cannot import native history with duplicate tool call IDs");
				callIds.add(block.id);
				return { ...block, id: nativeToolCallId(block.id) };
			}),
		};
	});
	// The converter omits its current-input slot. Supply one so a real trailing
	// historical user/developer is not accidentally omitted instead.
	const projection = await buildGrpcRequest(
		{ id: selection.id, name: selection.id, api: "cursor-agent", provider: "cursor" } as Parameters<typeof buildGrpcRequest>[0],
		{ messages: [...messages, { role: "user", content: "", timestamp: 0 }] },
		undefined,
		{ conversationId: "", blobStore: new Map() },
	);
	const data = toBinary(ConversationStateStructureSchema, projection.conversationState);
	const rootBlobId = createHash("sha256").update(data).digest("hex");
	projection.blobStore.set(rootBlobId, data);
	return { blobs: projection.blobStore, rootBlobId };
}

/** Read opaque checkpoint bytes only through the SDK's public, agent-scoped store. */
export async function readNativeCheckpoint(store: LocalAgentStore, agentId: string) {
	const agent = await store.agents.get({ agentId });
	if (!agent || agent.agentId !== agentId) throw new Error("Checkpoint agent is missing or mismatched");
	if (agent.latestCheckpoint && agent.latestCheckpoint.schemaVersion !== 1) throw new Error("Unsupported checkpoint schema");
	const rootBlobId = agent.latestCheckpoint?.rootBlobId;
	const bytes = rootBlobId ? await store.checkpoints.get({ agentId, blobId: rootBlobId }) : null;
	const tokenDetails = bytes ? ConversationStateStructureSchema.decode(bytes).tokenDetails : undefined;
	const current = await store.agents.get({ agentId });
	return {
		agentId: agent.agentId,
		status: agent.status,
		activeRunId: agent.activeRunId ?? null,
		updatedAt: agent.updatedAt,
		rootBlobId: rootBlobId ?? null,
		blobPresent: bytes !== null,
		stable: current?.agentId === agentId && current.updatedAt === agent.updatedAt &&
			current.status === agent.status && current.activeRunId === agent.activeRunId &&
			current.latestCheckpoint?.rootBlobId === rootBlobId &&
			current.latestCheckpoint?.schemaVersion === agent.latestCheckpoint?.schemaVersion,
		tokenDetails: tokenDetails ? { usedTokens: tokenDetails.usedTokens, maxTokens: tokenDetails.maxTokens } : null,
	};
}

/** Only a new, idle, stable checkpoint can describe the completed turn's context. */
export async function readSettledCheckpointOccupancy(store: LocalAgentStore, agentId: string, previousRoot: string | null) {
	try {
		const checkpoint = await readNativeCheckpoint(store, agentId);
		const tokens = checkpoint.tokenDetails;
		if (!checkpoint.stable || checkpoint.status !== "idle" || checkpoint.activeRunId ||
			!checkpoint.rootBlobId || checkpoint.rootBlobId === previousRoot || !tokens ||
			!Number.isSafeInteger(tokens.usedTokens) || tokens.usedTokens <= 0 ||
			!Number.isSafeInteger(tokens.maxTokens) || tokens.maxTokens <= 0) return undefined;
		return { status: "actual" as const, source: "checkpoint" as const,
			agentId, rootBlobId: checkpoint.rootBlobId, usedTokens: tokens.usedTokens, maxTokens: tokens.maxTokens };
	} catch {
		// Optional telemetry must never turn a successful answer into a failed turn.
		return undefined;
	}
}
