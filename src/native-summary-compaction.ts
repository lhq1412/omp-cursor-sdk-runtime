import { randomUUID } from "node:crypto";
import type { LocalAgentStore } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import type {
	CompactionEntry,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import { isUserRequestEntry } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_SDK_PROVIDER_ID } from "./constants.js";
import {
	locatorFor,
	locatorsMatch,
	projectSourceHistoryUnits,
	type MessageLocator,
	type SourceHistoryUnit,
} from "./context.js";
import {
	decodeCheckpointSummaryState,
	resolveEffectiveSummaryCoverage,
	type CursorSummaryCoverage,
	type NativeCheckpointArchives,
	type SummaryBoundaryObservation,
} from "./native-history.js";
import {
	getRuntimeSlot,
	listRuntimeSlots,
	markPersistedHandleDirtyPreservingAgent,
	runtimeKey,
	type RuntimeSlot,
} from "./session-runtime.js";
import { getCursorSessionOwner } from "./session-scope.js";

const NATIVE_SUMMARY_KIND = "cursor-sdk-native-summary";
const POLL_INTERVAL_MS = 50;
const POLL_DEADLINE_MS = 5000;

export interface PendingCursorCompaction {
	id: string;
	scopeKey: string;
	sessionId: string;
	agentInstanceId: string;
	agentId: string;
	checkpointRootBlobId: string;
	summaryGeneration: number;
	summary: string;
	archiveHash: string;
	coverage: CursorSummaryCoverage;
	tokensBefore: number;
	tokensBeforeSource: "checkpoint-before-summary" | "assistant-context-tokens" | "unavailable";
	sourceContextFingerprint: string;
	sourceUnits: SourceHistoryUnit[];
	sourceCompactionTimestamp?: number;
	state: "pending" | "materializing" | "committed" | "stale";
	lastAttemptError?: string;
}

interface MaterializationAttempt {
	id: string;
	sessionId: string;
	pendingId: string;
	hookEntered: boolean;
	committed: boolean;
	knownTailLocator?: MessageLocator;
}

interface PollState {
	epoch: number;
	timer?: ReturnType<ExtensionContext["setTimeout"]>;
	startedAt: number;
}

const pendingBySession = new Map<string, PendingCursorCompaction>();
const attempts = new Map<string, MaterializationAttempt>();
const mainSettleCandidates = new Map<string, number>();
const polls = new Map<string, PollState>();
const unverifiedCoverageBySession = new Map<string, Set<string>>();
const warnedCoverageBySession = new Map<string, Set<string>>();
let settleEpoch = 0;
let pollIntervalMs = POLL_INTERVAL_MS;
let pollDeadlineMs = POLL_DEADLINE_MS;

export interface BoundaryResult {
	firstKeptEntryId: string;
}

function latestCompaction(entries: SessionEntry[]): CompactionEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "compaction") return entry;
	}
}

function findUniqueEntryIndex(entries: SessionEntry[], locator: MessageLocator): number | undefined {
	const matches: number[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		if (locatorsMatch(locatorFor(entry.message), locator)) matches.push(index);
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export function resolveMaterializationBoundary(
	pending: PendingCursorCompaction,
	branchEntries: SessionEntry[],
): BoundaryResult | undefined {
	if (pending.state === "stale") return;
	const previous = latestCompaction(branchEntries);
	if (previous && !pending.coverage.includesPreviousSummary) {
		pending.state = "stale";
		return;
	}
	const turnUnits = pending.sourceUnits.filter((unit) => unit.kind === "turn");
	const retained = turnUnits[pending.coverage.expandedSummarizedTurnCount];
	if (!retained) {
		pending.state = "stale";
		return;
	}
	const exactIndex = findUniqueEntryIndex(branchEntries, retained.firstMessage);
	if (exactIndex === undefined) {
		pending.state = "stale";
		return;
	}
	let index = exactIndex;
	while (index >= 0 && !isUserRequestEntry(branchEntries[index]!)) index -= 1;
	if (index < 0) {
		pending.state = "stale";
		return;
	}
	const candidate = branchEntries[index];
	if (!candidate?.id) {
		pending.state = "stale";
		return;
	}
	if (previous) {
		const previousKept = branchEntries.findIndex((entry) => entry.id === previous.firstKeptEntryId);
		if (previousKept < 0 || index < previousKept) {
			pending.state = "stale";
			return;
		}
	}
	return { firstKeptEntryId: candidate.id };
}

function lastCursorAssistantContextTokens(messages: Context["messages"]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "assistant" || message.provider !== CURSOR_SDK_PROVIDER_ID) continue;
		const usage = message.usage as { contextTokens?: unknown } | undefined;
		const tokens = usage?.contextTokens;
		if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) return tokens;
	}
}

function sourceCompactionTimestamp(units: SourceHistoryUnit[]): number | undefined {
	for (let index = units.length - 1; index >= 0; index -= 1) {
		const timestamp = units[index]?.historyRewriteAt;
		if (timestamp !== undefined) return timestamp;
	}
}

function tokensBeforeFrom(observation: SummaryBoundaryObservation, context: Context): {
	tokensBefore: number;
	tokensBeforeSource: PendingCursorCompaction["tokensBeforeSource"];
} {
	if (typeof observation.before?.usedTokens === "number" && observation.before.usedTokens >= 0) {
		return { tokensBefore: observation.before.usedTokens, tokensBeforeSource: "checkpoint-before-summary" };
	}
	const assistant = lastCursorAssistantContextTokens(context.messages);
	if (assistant !== undefined) {
		return { tokensBefore: assistant, tokensBeforeSource: "assistant-context-tokens" };
	}
	return { tokensBefore: 0, tokensBeforeSource: "unavailable" };
}

function slotForPending(pending: PendingCursorCompaction): RuntimeSlot | undefined {
	return getRuntimeSlot(runtimeKey(pending.scopeKey, pending.agentInstanceId));
}

function stagingRequestAlive(input: {
	signal?: AbortSignal;
	slot: RuntimeSlot;
	agentId: string;
}, sessionId: string, ownerGeneration: number, slotKey: string): boolean {
	if (input.signal?.aborted || input.slot.preparation?.signal.aborted) return false;
	const current = getCursorSessionOwner();
	if (current.sessionId !== sessionId || current.generation !== ownerGeneration) return false;
	if (getRuntimeSlot(slotKey) !== input.slot) return false;
	// Successful settle only: cancel/dirty clears agent and leaves binding dirty.
	if (input.slot.bindingState !== "committed" || input.slot.agent?.agentId !== input.agentId) return false;
	return true;
}
function markCoverageUnverified(sessionId: string, agentId: string): void {
	const agents = unverifiedCoverageBySession.get(sessionId) ?? new Set<string>();
	agents.add(agentId);
	unverifiedCoverageBySession.set(sessionId, agents);
}

function clearUnverifiedCoverage(sessionId: string, agentId: string): void {
	const agents = unverifiedCoverageBySession.get(sessionId);
	agents?.delete(agentId);
	if (!agents?.size) unverifiedCoverageBySession.delete(sessionId);
}

function notifyUnverifiedCoverage(ctx: ExtensionContext, sessionId: string): void {
	const agents = unverifiedCoverageBySession.get(sessionId);
	if (!agents) return;
	const warned = warnedCoverageBySession.get(sessionId) ?? new Set<string>();
	for (const agentId of agents) {
		if (warned.has(agentId)) continue;
		warned.add(agentId);
		try {
			ctx.ui.notify(
				`Cursor native summary coverage could not be verified for agent ${agentId}; OMP history was left unchanged. Run /compact to compact normally.`,
				"warning",
			);
		} catch {
			// A UI warning must not fail the completed business turn.
		}
	}
	warnedCoverageBySession.set(sessionId, warned);
	unverifiedCoverageBySession.delete(sessionId);
}

export async function stageCursorCompaction(input: {
	observation: SummaryBoundaryObservation;
	context: Context;
	contextFingerprint: string;
	store: LocalAgentStore;
	slot: RuntimeSlot;
	agentId: string;
	signal?: AbortSignal;
}): Promise<PendingCursorCompaction | undefined> {
	const owner = getCursorSessionOwner();
	const sessionId = owner.sessionId;
	if (!sessionId) return;
	const ownerGeneration = owner.generation;
	const slotKey = runtimeKey(input.slot.scopeKey, input.slot.agentInstanceId);
	if (!stagingRequestAlive(input, sessionId, ownerGeneration, slotKey)) return;
	let after: NativeCheckpointArchives | undefined;
	try {
		const afterBytes = await input.store.checkpoints.get({ agentId: input.agentId, blobId: input.observation.afterRoot });
		after = afterBytes
			? await decodeCheckpointSummaryState(input.store, input.agentId, afterBytes)
			: undefined;
	} catch {
		after = undefined;
	}
	if (!stagingRequestAlive(input, sessionId, ownerGeneration, slotKey)) return;
	const existing = pendingBySession.get(sessionId);
	if (!after) {
		markCoverageUnverified(sessionId, input.agentId);
		if (existing?.state === "pending") existing.state = "stale";
		return existing;
	}
	const sourceUnits = projectSourceHistoryUnits(input.context.messages);
	const coverage = resolveEffectiveSummaryCoverage(after, sourceUnits, input.context.messages);
	if (!coverage) {
		markCoverageUnverified(sessionId, input.agentId);
		if (existing?.state === "pending") existing.state = "stale";
		return existing;
	}
	clearUnverifiedCoverage(sessionId, input.agentId);
	const tokens = tokensBeforeFrom(input.observation, input.context);
	const pending: PendingCursorCompaction = {
		id: randomUUID(),
		scopeKey: input.slot.scopeKey,
		sessionId,
		agentInstanceId: input.slot.agentInstanceId,
		agentId: input.agentId,
		checkpointRootBlobId: input.observation.afterRoot,
		summaryGeneration: input.observation.summaryGeneration,
		summary: coverage.summary,
		archiveHash: coverage.archiveHash,
		coverage,
		...tokens,
		sourceContextFingerprint: input.contextFingerprint,
		sourceUnits,
		...(sourceCompactionTimestamp(sourceUnits) !== undefined
			? { sourceCompactionTimestamp: sourceCompactionTimestamp(sourceUnits) }
			: {}),
		state: "pending",
	};
	if (!stagingRequestAlive(input, sessionId, ownerGeneration, slotKey)) return;
	pendingBySession.set(sessionId, pending);
	return pending;
}

export function noteMainSessionStop(sessionId: string | undefined): undefined {
	if (!sessionId) return;
	mainSettleCandidates.set(sessionId, ++settleEpoch);
	return undefined;
}

function clearPoll(sessionId: string, ctx?: ExtensionContext): void {
	const poll = polls.get(sessionId);
	if (poll?.timer && ctx) ctx.clearTimer(poll.timer);
	polls.delete(sessionId);
}

export function clearCoordinator(sessionId: string | undefined, ctx?: ExtensionContext): void {
	if (!sessionId) return;
	pendingBySession.delete(sessionId);
	unverifiedCoverageBySession.delete(sessionId);
	warnedCoverageBySession.delete(sessionId);
	attempts.delete(sessionId);
	mainSettleCandidates.delete(sessionId);
	clearPoll(sessionId, ctx);
}

function pendingFor(sessionId: string): PendingCursorCompaction | undefined {
	return pendingBySession.get(sessionId);
}

async function materialize(ctx: ExtensionContext, sessionId: string, pending: PendingCursorCompaction): Promise<void> {
	if (pending.state !== "pending") return;
	if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
	if (attempts.has(sessionId)) return;
	const slot = slotForPending(pending);
	pending.state = "materializing";
	const attempt: MaterializationAttempt = {
		id: randomUUID(),
		sessionId,
		pendingId: pending.id,
		hookEntered: false,
		committed: false,
		...(slot?.committedContextTail ? { knownTailLocator: slot.committedContextTail } : {}),
	};
	attempts.set(sessionId, attempt);
	try {
		await ctx.compact({ mode: "soft" });
	} catch (error) {
		pending.lastAttemptError = error instanceof Error ? error.message : String(error);
	} finally {
		attempts.delete(sessionId);
		if (pending.state === "materializing") pending.state = attempt.committed ? "committed" : "pending";
	}
}

function scheduleMaterializationPoll(ctx: ExtensionContext, sessionId: string): void {
	const previous = polls.get(sessionId);
	const epoch = (previous?.epoch ?? 0) + 1;
	if (previous?.timer) ctx.clearTimer(previous.timer);
	const startedAt = Date.now();
	const tick = () => {
		const current = polls.get(sessionId);
		if (!current || current.epoch !== epoch) return;
		const pending = pendingFor(sessionId);
		if (!pending || pending.state !== "pending") {
			polls.delete(sessionId);
			return;
		}
		if (attempts.has(sessionId)) return;
		if (ctx.isIdle() && !ctx.hasPendingMessages()) {
			polls.delete(sessionId);
			void materialize(ctx, sessionId, pending);
			return;
		}
		if (Date.now() - startedAt < pollDeadlineMs) {
			current.timer = ctx.setTimeout(tick, pollIntervalMs);
			return;
		}
		polls.delete(sessionId);
	};
	polls.set(sessionId, { epoch, startedAt, timer: ctx.setTimeout(tick, pollIntervalMs) });
}

export function onAgentEnd(event: { willContinue?: boolean }, ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId) return;
	const marker = mainSettleCandidates.get(sessionId);
	mainSettleCandidates.delete(sessionId);
	if (!marker || event.willContinue === true) return;
	notifyUnverifiedCoverage(ctx, sessionId);
	const pending = pendingFor(sessionId);
	if (!pending || pending.state !== "pending") return;
	scheduleMaterializationPoll(ctx, sessionId);
}

export function onSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId) return;
	const attempt = attempts.get(sessionId);
	const pending = pendingFor(sessionId);
	if (!attempt || !pending || pending.state !== "materializing" || attempt.pendingId !== pending.id) return;
	attempt.hookEntered = true;
	const boundary = resolveMaterializationBoundary(pending, event.branchEntries);
	if (!boundary) return { cancel: true as const };
	return {
		compaction: {
			summary: pending.summary,
			firstKeptEntryId: boundary.firstKeptEntryId,
			tokensBefore: pending.tokensBefore,
			details: {
				kind: NATIVE_SUMMARY_KIND,
				version: 1,
				materializationId: attempt.id,
				agentId: pending.agentId,
				checkpointRootBlobId: pending.checkpointRootBlobId,
				summaryGeneration: pending.summaryGeneration,
				archiveHash: pending.archiveHash,
				tokensBeforeSource: pending.tokensBeforeSource,
			},
		},
	};
}

function detailsRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function commitOwnMaterialization(event: SessionCompactEvent, ctx: ExtensionContext): boolean {
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId || !event.fromExtension) return false;
	const attempt = attempts.get(sessionId);
	const pending = pendingFor(sessionId);
	const details = detailsRecord(event.compactionEntry.details);
	if (!attempt || !pending) return false;
	if (details?.kind !== NATIVE_SUMMARY_KIND || details.materializationId !== attempt.id) return false;
	attempt.committed = true;
	pending.state = "committed";
	const slot = slotForPending(pending) ?? listRuntimeSlots().find((item) => item.scopeKey === pending.scopeKey);
	if (slot) {
		slot.pendingNativeRebase = {
			materializationId: attempt.id,
			compactionEntryId: event.compactionEntry.id,
			compactionTimestamp: Date.parse(event.compactionEntry.timestamp),
			checkpointRootBlobId: pending.checkpointRootBlobId,
			summaryGeneration: pending.summaryGeneration,
			archiveHash: pending.archiveHash,
			...(attempt.knownTailLocator ? { knownTailLocator: attempt.knownTailLocator } : {}),
		};
		markPersistedHandleDirtyPreservingAgent(slot);
	}
	return true;
}

export const __testUtils = {
	NATIVE_SUMMARY_KIND,
	clear() {
		pendingBySession.clear();
		attempts.clear();
		mainSettleCandidates.clear();
		unverifiedCoverageBySession.clear();
		warnedCoverageBySession.clear();
		polls.clear();
		settleEpoch = 0;
		pollIntervalMs = POLL_INTERVAL_MS;
		pollDeadlineMs = POLL_DEADLINE_MS;
	},
	pending: pendingBySession,
	attempts,
	mainSettleCandidates,
	setPollTiming(intervalMs: number, deadlineMs: number) {
		pollIntervalMs = intervalMs;
		pollDeadlineMs = deadlineMs;
	},
	getPending(sessionId: string) {
		return pendingBySession.get(sessionId);
	},
	stagePending(pending: PendingCursorCompaction) {
		pendingBySession.set(pending.sessionId, pending);
	},
	beginAttempt(pending: PendingCursorCompaction, extra?: Partial<MaterializationAttempt>) {
		const attempt: MaterializationAttempt = {
			id: extra?.id ?? randomUUID(),
			sessionId: pending.sessionId,
			pendingId: pending.id,
			hookEntered: extra?.hookEntered ?? false,
			committed: extra?.committed ?? false,
			...(extra?.knownTailLocator ? { knownTailLocator: extra.knownTailLocator } : {}),
		};
		pending.state = "materializing";
		attempts.set(pending.sessionId, attempt);
		return attempt;
	},
};
