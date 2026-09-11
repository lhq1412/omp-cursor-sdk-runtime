import "./sdk-exit-guard.js";
import { createHash } from "node:crypto";
import type { ModelSelection } from "@cursor/sdk";
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
