import "./sdk-exit-guard.js";
import { createHash } from "node:crypto";
import type { LocalAgentStore, ModelSelection } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import { ConversationStateStructureSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { pb, toBinary, type ProtoMessage } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { nativeToolCallId } from "./tool-call-id.js";
import type { SourceHistoryUnit } from "./context.js";
import { mapOmpToolName } from "./tools.js";

/** Project history only; the SDK remains responsible for creating and running agents. */
export async function buildNativeHistory(
	history: Context["messages"],
	selection: ModelSelection,
	toolNameMap?: ReadonlyMap<string, string>,
) {
	const callIds = new Set<string>();
	const ompBySdk = new Map<string, string>();
	const sdkToolName = (ompName: string): string => {
		const sdkName = toolNameMap?.get(ompName) ?? mapOmpToolName(ompName);
		const collision = ompBySdk.get(sdkName);
		if (collision && collision !== ompName) {
			throw new Error(`Cannot import native history: tools ${collision} and ${ompName} map to ${sdkName}`);
		}
		ompBySdk.set(sdkName, ompName);
		return sdkName;
	};
	const messages = history.map((message) => {
		if (message.role === "toolResult") {
			return {
				...message,
				toolCallId: nativeToolCallId(message.toolCallId),
				toolName: sdkToolName(message.toolName),
			};
		}
		if (message.role !== "assistant") return message;
		return {
			...message,
			content: message.content.map((block) => {
				if (block.type !== "toolCall") return block;
				if (callIds.has(block.id)) throw new Error("Cannot import native history with duplicate tool call IDs");
				callIds.add(block.id);
				return { ...block, id: nativeToolCallId(block.id), name: sdkToolName(block.name) };
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

interface DecodedModelMessage {
	role: string;
	anchors: string[];
	supported: boolean;
	userParts?: string[];
}
interface DecodedArchiveInteraction {
	anchors: string[];
	userParts: string[];
	hasResponse: boolean;
}

export interface DecodedCursorSummaryArchive {
	summarizedMessages: Uint8Array[];
	summarizedModelMessages: DecodedModelMessage[];
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

export function decodeConversationSummaryArchive(bytes: Uint8Array): Omit<DecodedCursorSummaryArchive, "summarizedModelMessages"> | undefined {
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

function blobId(reference: Uint8Array): string | undefined {
	return reference.byteLength === 32 ? Buffer.from(reference).toString("hex") : undefined;
}

function anchor(kind: string, value: string): string {
	return createHash("sha256").update(kind).update("\0").update(value).digest("hex");
}

function textParts(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content.trim()] : [];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const record = part as Record<string, unknown>;
		return record.type === "text" && typeof record.text === "string" && record.text.trim()
			? [record.text.trim()]
			: [];
	});
}
function decodedUserParts(content: unknown): string[] | undefined {
	const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
	if (!Array.isArray(parts)) return;
	const decoded: string[] = [];
	for (const part of parts) {
		if (!part || typeof part !== "object") return;
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			const text = record.text.trim();
			if (text) decoded.push(JSON.stringify(["text", text]));
			continue;
		}
		if (record.type !== "image" || typeof record.image !== "string" || typeof record.mediaType !== "string") return;
		const prefix = `data:${record.mediaType};base64,`;
		if (!record.image.startsWith(prefix)) return;
		decoded.push(JSON.stringify(["image", record.mediaType, record.image.slice(prefix.length)]));
	}
	return decoded;
}


function decodeModelMessage(bytes: Uint8Array): DecodedModelMessage | undefined {
	try {
		const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
		if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.role !== "string") return;
		const anchors: string[] = [];
		let supported = message.role === "system";
		let userParts: string[] | undefined;
		if (message.role === "user") {
			const content = message.content;
			userParts = decodedUserParts(content);
			supported = typeof content === "string" || (Array.isArray(content) && content.every((part) =>
				part && typeof part === "object" && (part as Record<string, unknown>).type === "text" &&
				typeof (part as Record<string, unknown>).text === "string"));
			const texts = textParts(content);
			if (supported && texts.length) anchors.push(anchor("user", texts.join("\n")));
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			supported = true;
			for (const part of message.content) {
				if (!part || typeof part !== "object") {
					supported = false;
					continue;
				}
				const record = part as Record<string, unknown>;
				if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
					anchors.push(anchor("assistant", record.text.trim()));
				} else if (
					(record.type === "reasoning" && typeof record.text === "string") ||
					(record.type === "redacted-reasoning" && typeof record.data === "string")
				) {
					// Native history may omit or redact model reasoning. It is not stable coverage identity.
				} else if (record.type === "tool-call" && typeof record.toolCallId === "string" &&
					typeof record.toolName === "string") {
					anchors.push(anchor("tool-call", JSON.stringify([
						record.toolCallId,
						record.toolName,
						record.input ?? record.args ?? {},
					])));
				} else {
					supported = false;
				}
			}
		} else if (message.role === "tool" && Array.isArray(message.content)) {
			supported = true;
			for (const part of message.content) {
				if (!part || typeof part !== "object") {
					supported = false;
					continue;
				}
				const record = part as Record<string, unknown>;
				const toolCallId = typeof record.toolCallId === "string"
					? record.toolCallId
					: typeof message.id === "string" ? message.id : undefined;
				if (record.type !== "tool-result" || !toolCallId || typeof record.toolName !== "string") {
					supported = false;
					continue;
				}
				anchors.push(anchor("tool-result", JSON.stringify([
					toolCallId,
					record.toolName,
					typeof record.result === "string" ? record.result.trim() : record.result,
					record.isError === true,
				])));
			}
		}
		return { role: message.role, anchors, supported, ...(userParts ? { userParts } : {}) };
	} catch {
		return;
	}
}

async function readReferencedBlob(store: LocalAgentStore, agentId: string, reference: Uint8Array): Promise<Uint8Array | undefined> {
	const id = blobId(reference);
	if (!id) return;
	const bytes = await store.checkpoints.get({ agentId, blobId: id });
	if (!bytes || createHash("sha256").update(bytes).digest("hex") !== id) return;
	return bytes;
}

export async function decodeCheckpointSummaryState(
	store: LocalAgentStore,
	agentId: string,
	bytes: Uint8Array,
): Promise<NativeCheckpointArchives | undefined> {
	try {
		const state = ConversationStateStructureSchema.decode(bytes);
		const archives: DecodedCursorSummaryArchive[] = [];
		for (const reference of rawArchivesFromState(state)) {
			const archiveBytes = await readReferencedBlob(store, agentId, reference);
			const decoded = archiveBytes ? decodeConversationSummaryArchive(archiveBytes) : undefined;
			if (!decoded) return;
			const summarizedModelMessages: DecodedModelMessage[] = [];
			for (const messageReference of decoded.summarizedMessages) {
				const messageBytes = await readReferencedBlob(store, agentId, messageReference);
				const message = messageBytes ? decodeModelMessage(messageBytes) : undefined;
				if (!message) return;
				summarizedModelMessages.push(message);
			}
			const summaryMessageBytes = await readReferencedBlob(store, agentId, decoded.summaryMessage);
			if (!summaryMessageBytes || decodeModelMessage(summaryMessageBytes)?.role !== "user") return;
			archives.push({ ...decoded, summarizedModelMessages });
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

function archiveInteractions(
	archives: DecodedCursorSummaryArchive[],
	index: number,
	expandPrevious: boolean,
	seen = new Set<number>(),
): { interactions: DecodedArchiveInteraction[]; previous: number[] } | undefined {
	if (seen.has(index)) return;
	seen.add(index);
	const archive = archives[index];
	if (!archive) return;
	const interactions: DecodedArchiveInteraction[] = [];
	const previous: number[] = [];
	let current: string[] | undefined;
	let currentUserParts: string[] = [];
	let currentHasResponse = false;
	let currentSupported = false;
	const finishCurrent = () => {
		if (!current) return;
		interactions.push({
			anchors: currentSupported && current.length > 1 ? current : [],
			userParts: currentUserParts,
			hasResponse: currentHasResponse,
		});
		current = undefined;
		currentUserParts = [];
		currentHasResponse = false;
		currentSupported = false;
	};
	for (let messageIndex = 0; messageIndex < archive.summarizedMessages.length; messageIndex += 1) {
		const prior = previousSummaryIndex(archives, archive.summarizedMessages[messageIndex]!, index);
		if (prior >= 0) {
			finishCurrent();
			previous.push(prior);
			if (expandPrevious) {
				const expanded = archiveInteractions(archives, prior, true, seen);
				if (!expanded) return;
				interactions.push(...expanded.interactions);
			}
			continue;
		}
		const message = archive.summarizedModelMessages[messageIndex]!;
		if (message.role === "user") {
			finishCurrent();
			current = [...message.anchors];
			currentUserParts = message.userParts ?? [];
			currentSupported = message.supported && message.anchors.length === 1;
		} else if (current) {
			currentHasResponse = true;
			current.push(...message.anchors);
			currentSupported = currentSupported && message.supported;
		}
	}
	finishCurrent();
	return { interactions, previous };
}

function sourceUnitAnchors(unit: SourceHistoryUnit, messages: Context["messages"]): string[] {
	const anchors: string[] = [];
	const pendingTools = new Set<string>();
	let sawUser = false;
	for (let index = unit.startMessageIndex; index <= unit.endMessageIndex; index += 1) {
		const message = messages[index];
		if (!message) return [];
		if (message.role === "user" || message.role === "developer") {
			if (sawUser || (Array.isArray(message.content) && message.content.some((part) => part.type !== "text"))) return [];
			const texts = textParts(message.content);
			if (!texts.length) return [];
			sawUser = true;
			anchors.push(anchor("user", texts.join("\n")));
			continue;
		}
		if (message.role === "toolResult") {
			const id = nativeToolCallId(message.toolCallId);
			if (!pendingTools.delete(id) || !Array.isArray(message.content) ||
				message.content.some((part) => part.type !== "text")) return [];
			anchors.push(anchor("tool-result", JSON.stringify([
				id,
				mapOmpToolName(message.toolName),
				// Importer shape: raw texts joined by "\n"; trimmed on both sides.
				message.content.map((part) => (part as { text: string }).text).join("\n").trim(),
				message.isError === true,
			])));
			continue;
		}
		if (message.role !== "assistant") return [];
		for (const part of message.content) {
			if (part.type === "toolCall") {
				const id = nativeToolCallId(part.id);
				if (pendingTools.has(id)) return [];
				pendingTools.add(id);
				anchors.push(anchor("tool-call", JSON.stringify([id, mapOmpToolName(part.name), part.arguments ?? {}])));
			} else if (part.type === "text" && part.text.trim()) {
				anchors.push(anchor("assistant", part.text.trim()));
			} else if (part.type === "thinking" && typeof part.thinking === "string") {
				// The native history mapper may omit this provider-private state.
			} else {
				return [];
			}
		}
	}
	return sawUser && !pendingTools.size && anchors.length > 1 ? anchors : [];
}
function sourceSummaryParts(unit: SourceHistoryUnit, messages: Context["messages"]): string[] | undefined {
	if (unit.startMessageIndex !== unit.endMessageIndex) return;
	const message = messages[unit.startMessageIndex];
	if (!message || message.role !== "user") return;
	if (typeof message.content === "string") {
		const text = message.content.trim();
		return text ? [JSON.stringify(["text", text])] : undefined;
	}
	const content = message.content;
	if (!Array.isArray(content)) return;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") {
			const text = part.text.trim();
			if (text) parts.push(JSON.stringify(["text", text]));
		} else if (part.type === "image") {
			parts.push(JSON.stringify(["image", part.mimeType, part.data]));
		} else {
			return;
		}
	}
	return parts.length ? parts : undefined;
}


function anchorsEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/**
 * Align the native model-message archive to complete OMP source interactions.
 * Blob counts are deliberately irrelevant: a native turn expands to many
 * model messages, and summaries may be generated during a parked interaction.
 */
export function resolveEffectiveSummaryCoverage(
	after: NativeCheckpointArchives,
	sourceUnits: SourceHistoryUnit[],
	messages: Context["messages"],
): CursorSummaryCoverage | undefined {
	if (!after.archives.length) return;
	const archives = after.archives;
	const latestIndex = archives.length - 1;
	const latest = archives[latestIndex]!;
	if (!latest.summary) return;
	const materializedSummary = sourceUnits[0]?.kind === "compaction-summary" ? sourceUnits[0] : undefined;
	const expanded = archiveInteractions(archives, latestIndex, !materializedSummary);
	if (!expanded) return;
	const firstInteraction = expanded.interactions[0];
	const summaryParts = materializedSummary ? sourceSummaryParts(materializedSummary, messages) : undefined;
	const importedMaterializedSummary = expanded.previous.length === 0 &&
		firstInteraction !== undefined &&
		!firstInteraction.hasResponse &&
		summaryParts !== undefined &&
		firstInteraction.userParts.length >= summaryParts.length &&
		summaryParts.every((part, index) =>
			firstInteraction.userParts[firstInteraction.userParts.length - summaryParts.length + index] === part);
	if (materializedSummary && expanded.previous.length === 0 && !importedMaterializedSummary) return;
	const interactions = importedMaterializedSummary ? expanded.interactions.slice(1) : expanded.interactions;
	const units: CursorCoverageUnit[] = expanded.previous.map((previous) => ({
		kind: "previous-summary",
		summaryGeneration: previous + 1,
		summaryMessageHash: archives[previous]!.summaryMessageHash,
	}));
	const turnUnits = sourceUnits.filter((unit) => unit.kind === "turn");
	const requiredByUnit = new Map<SourceHistoryUnit, string[]>();
	const signatureCounts = new Map<string, number>();
	for (const source of turnUnits) {
		const required = sourceUnitAnchors(source, messages);
		requiredByUnit.set(source, required);
		const signature = required.join("\0");
		if (signature) signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
	}
	let matchedTurns = 0;
	while (matchedTurns < turnUnits.length && matchedTurns < interactions.length) {
		const source = turnUnits[matchedTurns]!;
		const required = requiredByUnit.get(source) ?? [];
		if (!required.length || signatureCounts.get(required.join("\0")) !== 1) break;
		if (!anchorsEqual(required, interactions[matchedTurns]!.anchors)) break;
		units.push({ kind: "history-turn", sourceUnitOrdinal: source.ordinal });
		matchedTurns += 1;
	}
	if (!matchedTurns || matchedTurns >= turnUnits.length) return;
	return {
		summary: latest.summary,
		summarizedTurnCount: matchedTurns,
		windowTail: latest.windowTail,
		units,
		includesPreviousSummary: importedMaterializedSummary || expanded.previous.length > 0,
		archiveHash: latest.archiveHash,
		expandedSummarizedTurnCount: matchedTurns,
	};
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

/** Reconcile a completed summary from stable checkpoints when SDK delta events were absent. */
export async function reconcileSummaryBoundary(
	store: LocalAgentStore,
	agentId: string,
	previousRoot: string | null,
): Promise<SummaryBoundaryObservation | undefined> {
	try {
		const checkpoint = await readNativeCheckpoint(store, agentId);
		if (!checkpoint.stable || checkpoint.status !== "idle" || checkpoint.activeRunId ||
			!checkpoint.rootBlobId || checkpoint.rootBlobId === previousRoot || !checkpoint.probe) return;
		const before = previousRoot ? await readCheckpointProbe(store, agentId, previousRoot) : undefined;
		const beforeArchiveCount = before ? before.summaryArchive + before.summaryArchives : 0;
		const afterArchiveCount = checkpoint.probe.summaryArchive + checkpoint.probe.summaryArchives;
		if (checkpoint.probe.selfSummaryCount <= (before?.selfSummaryCount ?? 0) ||
			afterArchiveCount <= beforeArchiveCount) return;
		return {
			summaryGeneration: checkpoint.probe.selfSummaryCount,
			beforeRoot: previousRoot,
			afterRoot: checkpoint.rootBlobId,
			...(before ? { before } : {}),
			after: checkpoint.probe,
		};
	} catch {
		return;
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
