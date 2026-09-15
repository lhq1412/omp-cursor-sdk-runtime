import "./sdk-exit-guard.js";
import { createHash } from "node:crypto";
import type { LocalAgentStore, ModelSelection } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import { ConversationStateStructureSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { nativeToolCallId } from "./tool-call-id.js";

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

export interface NativeSummaryStateProbe {
	rootBlobId: string;
	turns: number;
	turnsOld: number;
	summaryArchive: number;
	summaryArchives: number;
	selfSummaryCount: number;
	summaryBytes: number;
	summaryArchiveBytes: number;
	summaryHash?: string;
	archivesHash?: string;
	usedTokens?: number;
	maxTokens?: number;
}

export interface SummaryBoundaryObservation {
	summaryGeneration: number;
	beforeRoot: string | null;
	afterRoot: string;
	before?: NativeSummaryStateProbe;
	after: NativeSummaryStateProbe;
	runEvent?: {
		eventType: string;
		messageCount?: number;
		messagesToCompact?: number;
	};
}

function shortHash(parts: Uint8Array[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return hash.digest("hex").slice(0, 16);
}

function summaryProbeFrom(rootBlobId: string, bytes: Uint8Array): NativeSummaryStateProbe {
	const state = ConversationStateStructureSchema.decode(bytes);
	const archives = [
		...(state.summaryArchive?.byteLength ? [state.summaryArchive] : []),
		...state.summaryArchives,
	];
	const summaryBytes = state.summary?.byteLength ?? 0;
	const summaryArchiveBytes = archives.reduce((n, part) => n + part.byteLength, 0);
	return {
		rootBlobId,
		turns: state.turns.length,
		turnsOld: state.turnsOld.length,
		summaryArchive: state.summaryArchive?.byteLength ? 1 : 0,
		summaryArchives: state.summaryArchives.length,
		selfSummaryCount: state.selfSummaryCount,
		summaryBytes,
		summaryArchiveBytes,
		...(summaryBytes && state.summary ? { summaryHash: shortHash([state.summary]) } : {}),
		...(summaryArchiveBytes ? { archivesHash: shortHash(archives) } : {}),
		...(state.tokenDetails ? { usedTokens: state.tokenDetails.usedTokens, maxTokens: state.tokenDetails.maxTokens } : {}),
	};
}

function asCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function compactCounts(payload: unknown, depth = 0): { messageCount?: number; messagesToCompact?: number } | undefined {
	if (depth > 2 || payload === null || typeof payload !== "object") return;
	const record = payload as Record<string, unknown>;
	const messageCount = asCount(record.message_count ?? record.messageCount);
	const messagesToCompact = asCount(record.messages_to_compact ?? record.messagesToCompact);
	if (messageCount !== undefined || messagesToCompact !== undefined) {
		return {
			...(messageCount !== undefined ? { messageCount } : {}),
			...(messagesToCompact !== undefined ? { messagesToCompact } : {}),
		};
	}
	for (const value of Object.values(record)) {
		const nested = compactCounts(value, depth + 1);
		if (nested) return nested;
	}
}

/** Read opaque checkpoint bytes only through the SDK's public, agent-scoped store. */
export async function readNativeCheckpoint(store: LocalAgentStore, agentId: string) {
	const agent = await store.agents.get({ agentId });
	if (!agent || agent.agentId !== agentId) throw new Error("Checkpoint agent is missing or mismatched");
	if (agent.latestCheckpoint && agent.latestCheckpoint.schemaVersion !== 1) throw new Error("Unsupported checkpoint schema");
	const rootBlobId = agent.latestCheckpoint?.rootBlobId;
	const bytes = rootBlobId ? await store.checkpoints.get({ agentId, blobId: rootBlobId }) : null;
	const probe = bytes && rootBlobId ? summaryProbeFrom(rootBlobId, bytes) : null;
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
		tokenDetails: probe && probe.usedTokens !== undefined && probe.maxTokens !== undefined
			? { usedTokens: probe.usedTokens, maxTokens: probe.maxTokens }
			: null,
		probe,
	};
}

export async function readCheckpointProbe(store: LocalAgentStore, agentId: string, blobId: string) {
	try {
		const bytes = await store.checkpoints.get({ agentId, blobId });
		return bytes ? summaryProbeFrom(blobId, bytes) : undefined;
	} catch {
		return undefined;
	}
}

export function createSummaryBoundaryProbe(store: LocalAgentStore) {
	let startSeq = 0;
	let generation = 0;
	let waiting = false;
	let latestRoot: string | null = null;
	let beforeRoot: string | null = null;
	let before: NativeSummaryStateProbe | undefined;
	let afterRoot: string | undefined;
	let observation: SummaryBoundaryObservation | undefined;
	let capturing: Promise<void> | undefined;
	let runEvent: SummaryBoundaryObservation["runEvent"];

	async function capture(agentId: string, root: string) {
		const after = await readCheckpointProbe(store, agentId, root);
		if (!after || afterRoot !== root) return;
		waiting = false;
		observation = {
			summaryGeneration: generation,
			beforeRoot,
			afterRoot: root,
			...(before ? { before } : {}),
			after,
			...(runEvent ? { runEvent } : {}),
		};
	}

	return {
		seed(root: string | null) {
			if (!waiting) latestRoot = root;
		},
		async onSummaryStarted(agentId: string) {
			const token = ++startSeq;
			waiting = false;
			afterRoot = undefined;
			observation = undefined;
			capturing = undefined;
			beforeRoot = latestRoot;
			before = undefined;
			const probe = beforeRoot
				? await readCheckpointProbe(store, agentId, beforeRoot)
				: (await readNativeCheckpoint(store, agentId).catch(() => undefined))?.probe ?? undefined;
			if (token !== startSeq) return;
			before = probe;
			if (probe) beforeRoot = probe.rootBlobId;
		},
		onSummaryCompleted() {
			generation += 1;
			waiting = true;
		},
		onAgentUpdated(agent: {
			agentId: string;
			status?: string;
			activeRunId?: string | null;
			latestCheckpoint?: { rootBlobId: string } | null;
		}) {
			const root = agent.latestCheckpoint?.rootBlobId ?? null;
			if (!waiting) {
				latestRoot = root;
				return;
			}
			if (agent.status !== "idle" || agent.activeRunId || !root || root === beforeRoot || afterRoot) return;
			afterRoot = root;
			capturing = capture(agent.agentId, root);
		},
		onRunEvent(event: { eventType: string; payload?: unknown }) {
			const counts = compactCounts(event.payload);
			const type = event.eventType.toLowerCase();
			if (!counts && !type.includes("compact") && !type.includes("summar")) return;
			runEvent = { eventType: event.eventType, ...counts };
		},
		async flush() {
			if (capturing) await capturing;
			const result = observation;
			observation = undefined;
			return result;
		},
	};
}

export type SummaryBoundaryProbe = ReturnType<typeof createSummaryBoundaryProbe>;

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
