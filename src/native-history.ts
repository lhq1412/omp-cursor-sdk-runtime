import "./sdk-exit-guard.js";
import { createHash } from "node:crypto";
import type { LocalAgentStore, ModelSelection } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import { ConversationStateStructureSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { pb, toBinary, type ProtoMessage } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { nativeToolCallId } from "./tool-call-id.js";
import type { SourceHistoryUnit } from "./context.js";

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

export interface SummaryRunEventNote {
	runId?: string;
	seq: number;
	eventType: string;
	messageCount?: number;
	messagesToCompact?: number;
}

export interface SummaryBoundaryObservation {
	summaryGeneration: number;
	beforeRoot: string | null;
	afterRoot: string;
	before?: NativeSummaryStateProbe;
	after: NativeSummaryStateProbe;
	runEvent?: SummaryRunEventNote;
}

export interface SummaryBoundaryProbe {
	seed(root: string | null): void;
	onSummaryStarted(agentId: string): Promise<void>;
	onSummaryCompleted(): void;
	onAgentUpdated(agent: {
		agentId: string;
		status?: string;
		activeRunId?: string | null;
		latestCheckpoint?: { rootBlobId: string } | null;
	}): void;
	onRunEvent(event: { runId?: string; eventType: string; payload?: unknown }): void;
	flush(): Promise<SummaryBoundaryObservation | undefined>;
}

function shortHash(parts: Uint8Array[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part);
	return hash.digest("hex").slice(0, 16);
}

export interface ConversationSummaryArchive extends ProtoMessage {
	summarizedMessages: Uint8Array[];
	summary: string;
	windowTail: number;
	summaryMessage: Uint8Array;
}

export const ConversationSummaryArchiveSchema = pb<ConversationSummaryArchive>("agent.v1.ConversationSummaryArchive", [
	{ no: 1, name: "summarizedMessages", kind: "bytes", repeat: true },
	{ no: 2, name: "summary", kind: "string" },
	{ no: 3, name: "windowTail", kind: "uint32" },
	{ no: 4, name: "summaryMessage", kind: "bytes" },
]);

export interface DecodedCursorSummaryArchive {
	summarizedMessages: Uint8Array[];
	summary: string;
	windowTail: number;
	summaryMessage: Uint8Array;
	archiveHash: string;
	summaryMessageHash: string;
}

export type CursorCoverageUnit =
	| { kind: "history-turn"; sourceUnitOrdinal: number }
	| { kind: "previous-summary"; summaryGeneration: number; summaryMessageHash: string };

export interface CursorSummaryCoverage {
	summary: string;
	summarizedTurnCount: number;
	windowTail: number;
	units: CursorCoverageUnit[];
	includesPreviousSummary: boolean;
	archiveHash: string;
	expandedSummarizedTurnCount: number;
}

export interface NativeCheckpointArchives {
	turns: number;
	selfSummaryCount: number;
	usedTokens?: number;
	summary?: Uint8Array;
	archives: DecodedCursorSummaryArchive[];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let i = 0; i < left.byteLength; i += 1) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

export function decodeConversationSummaryArchive(bytes: Uint8Array): DecodedCursorSummaryArchive | undefined {
	if (!bytes.byteLength) return;
	try {
		const decoded = ConversationSummaryArchiveSchema.decode(bytes);
		return {
			summarizedMessages: decoded.summarizedMessages,
			summary: decoded.summary,
			windowTail: decoded.windowTail,
			summaryMessage: decoded.summaryMessage,
			archiveHash: shortHash([bytes]),
			summaryMessageHash: decoded.summaryMessage.byteLength ? shortHash([decoded.summaryMessage]) : "",
		};
	} catch {
		return;
	}
}

function rawArchivesFromState(state: { summaryArchive?: Uint8Array; summaryArchives: Uint8Array[] }): Uint8Array[] {
	return [
		...(state.summaryArchive?.byteLength ? [state.summaryArchive] : []),
		...state.summaryArchives.filter((part) => part.byteLength),
	];
}

export function decodeCheckpointSummaryState(bytes: Uint8Array): NativeCheckpointArchives | undefined {
	try {
		const state = ConversationStateStructureSchema.decode(bytes);
		const archives: DecodedCursorSummaryArchive[] = [];
		for (const part of rawArchivesFromState(state)) {
			const decoded = decodeConversationSummaryArchive(part);
			if (!decoded) return;
			archives.push(decoded);
		}
		return {
			turns: state.turns.length,
			selfSummaryCount: state.selfSummaryCount,
			...(state.tokenDetails ? { usedTokens: state.tokenDetails.usedTokens } : {}),
			...(state.summary?.byteLength ? { summary: state.summary } : {}),
			archives,
		};
	} catch {
		return;
	}
}

function previousSummaryIndex(archives: DecodedCursorSummaryArchive[], message: Uint8Array, before: number): number {
	for (let index = 0; index < before; index += 1) {
		if (archives[index] && bytesEqual(archives[index].summaryMessage, message)) return index;
	}
	return -1;
}

function expandedHistoryTurns(archives: DecodedCursorSummaryArchive[], index: number, seen: Set<number>): number {
	if (seen.has(index)) return 0;
	seen.add(index);
	const archive = archives[index];
	if (!archive) return 0;
	let count = 0;
	for (const message of archive.summarizedMessages) {
		const previous = previousSummaryIndex(archives, message, index);
		count += previous >= 0 ? expandedHistoryTurns(archives, previous, seen) : 1;
	}
	return count;
}

/**
 * Frozen alignment:
 *   expandedSummarizedTurnCount + windowTail === source turn units
 *   after.turns === windowTail
 * Previous-summary identity is byte-equal summary_message in a later archive.
 * Any conversation that fails the equality is inapplicable (stale), including
 * continueOnly extra native turns and merged developer sequences.
 */
export function resolveEffectiveSummaryCoverage(
	before: NativeCheckpointArchives | undefined,
	after: NativeCheckpointArchives,
	sourceUnits: SourceHistoryUnit[],
): CursorSummaryCoverage | undefined {
	if (!after.archives.length) return;
	const archives = after.archives;
	const latestIndex = archives.length - 1;
	const latest = archives[latestIndex]!;
	if (!latest.summary) return;
	const turnUnits = sourceUnits.filter((unit) => unit.kind === "turn");
	const units: CursorCoverageUnit[] = [];
	let turnCursor = 0;
	let includesPreviousSummary = false;
	for (const message of latest.summarizedMessages) {
		const previous = previousSummaryIndex(archives, message, latestIndex);
		if (previous >= 0) {
			includesPreviousSummary = true;
			units.push({
				kind: "previous-summary",
				summaryGeneration: previous + 1,
				summaryMessageHash: archives[previous]!.summaryMessageHash,
			});
			turnCursor += expandedHistoryTurns(archives, previous, new Set());
			continue;
		}
		const source = turnUnits[turnCursor];
		if (!source) return;
		units.push({ kind: "history-turn", sourceUnitOrdinal: source.ordinal });
		turnCursor += 1;
	}
	const expandedSummarizedTurnCount = expandedHistoryTurns(archives, latestIndex, new Set());
	const summarizedTurnCount = units.filter((unit) => unit.kind === "history-turn").length;
	return {
		summary: latest.summary,
		summarizedTurnCount,
		windowTail: latest.windowTail,
		units,
		includesPreviousSummary,
		archiveHash: latest.archiveHash,
		expandedSummarizedTurnCount,
	};
}

export function validateNativeTurnAlignment(
	coverage: CursorSummaryCoverage,
	sourceUnits: SourceHistoryUnit[],
	afterTurns: number,
	beforeTurns?: number,
): boolean {
	const turnUnits = sourceUnits.filter((unit) => unit.kind === "turn");
	if (coverage.windowTail !== afterTurns) return false;
	if (coverage.expandedSummarizedTurnCount + coverage.windowTail !== turnUnits.length) return false;
	if (!coverage.includesPreviousSummary && beforeTurns !== undefined && beforeTurns !== turnUnits.length) return false;
	return true;
}


function summaryProbeFrom(rootBlobId: string, bytes: Uint8Array): NativeSummaryStateProbe {
	const state = ConversationStateStructureSchema.decode(bytes);
	const archives = rawArchivesFromState(state);
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

export function createSummaryBoundaryProbe(store: LocalAgentStore): SummaryBoundaryProbe {
	let startSeq = 0;
	let generation = 0;
	let waiting = false;
	let cycleOpen = false;
	let latestRoot: string | null = null;
	let beforeRoot: string | null = null;
	let before: NativeSummaryStateProbe | undefined;
	let afterRoot: string | undefined;
	let observation: SummaryBoundaryObservation | undefined;
	let capturing: Promise<void> | undefined;
	let beforeCapture: Promise<void> | undefined;
	let eventSeq = 0;
	let usedSeq = 0;
	let latest: SummaryRunEventNote | undefined;
	let cycleRunEvent: SummaryRunEventNote | undefined;

	async function capture(agentId: string, root: string) {
		if (beforeCapture) await beforeCapture;
		const after = await readCheckpointProbe(store, agentId, root);
		if (!after || afterRoot !== root) return;
		waiting = false;
		cycleOpen = false;
		const attached = cycleRunEvent && cycleRunEvent.seq > usedSeq ? cycleRunEvent : undefined;
		if (attached) usedSeq = attached.seq;
		cycleRunEvent = undefined;
		observation = {
			summaryGeneration: generation,
			beforeRoot,
			afterRoot: root,
			...(before ? { before } : {}),
			after,
			...(attached ? { runEvent: attached } : {}),
		};
	}

	return {
		seed(root) {
			if (!waiting) latestRoot = root;
		},
		onSummaryStarted(agentId) {
			const token = ++startSeq;
			waiting = false;
			if (cycleRunEvent && cycleRunEvent.seq > usedSeq) usedSeq = cycleRunEvent.seq;
			cycleOpen = true;
			afterRoot = undefined;
			observation = undefined;
			capturing = undefined;
			beforeRoot = latestRoot;
			before = undefined;
			cycleRunEvent = latest && latest.seq > usedSeq ? latest : undefined;
			beforeCapture = (async () => {
				const probe = beforeRoot
					? await readCheckpointProbe(store, agentId, beforeRoot)
					: (await readNativeCheckpoint(store, agentId).catch(() => undefined))?.probe ?? undefined;
				if (token !== startSeq) return;
				before = probe;
				if (probe) beforeRoot = probe.rootBlobId;
			})();
			return beforeCapture;
		},
		onSummaryCompleted() {
			generation += 1;
			waiting = true;
			cycleOpen = false;
		},
		onAgentUpdated(agent) {
			const root = agent.latestCheckpoint?.rootBlobId ?? null;
			if (!waiting) {
				latestRoot = root;
				return;
			}
			if (agent.status !== "idle" || agent.activeRunId || !root || root === beforeRoot || afterRoot) return;
			afterRoot = root;
			capturing = capture(agent.agentId, root);
		},
		onRunEvent(event) {
			const counts = compactCounts(event.payload);
			const type = event.eventType.toLowerCase();
			if (!counts && !type.includes("compact") && !type.includes("summar")) return;
			eventSeq += 1;
			latest = {
				seq: eventSeq,
				eventType: event.eventType,
				...(event.runId ? { runId: event.runId } : {}),
				...counts,
			};
			if (cycleOpen && latest.seq > usedSeq) cycleRunEvent = latest;
		},
		async flush() {
			if (beforeCapture) await beforeCapture;
			if (capturing) await capturing;
			const result = observation;
			observation = undefined;
			return result;
		},
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
