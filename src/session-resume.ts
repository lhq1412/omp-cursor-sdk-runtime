import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE } from "./constants.js";
import type { BindingState } from "./contracts.js";
import type { SendState } from "./context.js";
import { getCursorSessionOwner, getCursorSessionScopeKey, sessionEvents, type CursorSessionOwner } from "./session-scope.js";

export const RESUME_ENTRY_VERSION = 3;

export interface ResumeStoreIdentity {
	version: 1;
	stateRoot: string;
}

export interface ResumeSessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
	message?: { role?: string };
}

export interface ResumeEntryData {
	version: 1 | 2 | 3;
	runtime: "local";
	agentId: string;
	scopeKey: string;
	sessionFile?: string;
	sessionId?: string;
	cwd: string;
	poolKey: string;
	branchPathHash: string;
	compactionGeneration: number;
	sendState: SendState;
	createdAt: string;
	storeIdentity?: ResumeStoreIdentity;
	state?: BindingState;
	agentInstanceId?: string;
	credentialScopeId?: string;
}

export interface ResumeScope {
	scopeKey: string;
	sessionFile?: string;
	sessionId?: string;
	cwd: string;
}

interface PendingResumeHandle {
	agentId: string;
	poolKey: string;
	sendState: SendState;
	storeIdentity: ResumeStoreIdentity;
	state: BindingState;
	agentInstanceId: string;
	cwd: string;
	credentialScopeId?: string;
}

interface ResumeState {
	appendEntry?: ExtensionAPI["appendEntry"];
	scopeKey: string;
	sessionFile?: string;
	sessionId?: string;
	cwd: string;
	branchPathHash: string;
	compactionGeneration: number;
	activeHandle?: ResumeEntryData;
	pendingHandle?: PendingResumeHandle;
	unownedUserEntryIds: Set<string>;
}

function hashParts(parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash.update(part);
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 32);
}

export const EMPTY_BRANCH_HASH = hashParts(["cursor-sdk-agent-resume-branch", "v1"]);

export function hashBranchStep(previous: string, entry: ResumeSessionEntry): string {
	return hashParts([
		previous,
		entry.type,
		entry.id,
		entry.parentId ?? "",
		entry.type === "custom" ? (entry.customType ?? "") : "",
	]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function isSendState(value: unknown): value is SendState {
	const record = asRecord(value);
	return (
		typeof record?.bootstrapped === "boolean" &&
		typeof record.contextFingerprint === "string" &&
		typeof record.incrementalSendCount === "number"
	);
}

export function isLocalAgentId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.startsWith("bc-");
}

function parseStoreIdentity(value: unknown): ResumeStoreIdentity | undefined {
	const record = asRecord(value);
	if (record?.version !== 1 || typeof record.stateRoot !== "string" || !record.stateRoot) return undefined;
	return { version: 1, stateRoot: record.stateRoot };
}

function parseBindingState(value: unknown): BindingState | undefined {
	return value === "committed" || value === "in-flight" || value === "dirty" ? value : undefined;
}

export function parseResumeEntryData(value: unknown): ResumeEntryData | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (record.version !== 1 && record.version !== 2 && record.version !== 3) return undefined;
	if (record.runtime !== "local") return undefined;
	if (
		!isLocalAgentId(record.agentId) ||
		typeof record.scopeKey !== "string" ||
		typeof record.cwd !== "string" ||
		typeof record.poolKey !== "string" ||
		typeof record.branchPathHash !== "string" ||
		typeof record.compactionGeneration !== "number" ||
		typeof record.createdAt !== "string" ||
		!isSendState(record.sendState)
	) {
		return undefined;
	}
	if (record.sessionFile !== undefined && typeof record.sessionFile !== "string") return undefined;
	if (record.sessionId !== undefined && typeof record.sessionId !== "string") return undefined;
	const storeIdentity = parseStoreIdentity(record.storeIdentity);
	if (record.version >= 2 && !storeIdentity) return undefined;
	return {
		version: record.version,
		runtime: "local",
		agentId: record.agentId,
		scopeKey: record.scopeKey,
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		...(record.sessionId ? { sessionId: record.sessionId } : {}),
		cwd: record.cwd,
		poolKey: record.poolKey,
		branchPathHash: record.branchPathHash,
		compactionGeneration: record.compactionGeneration,
		sendState: {
			bootstrapped: record.sendState.bootstrapped,
			contextFingerprint: record.sendState.contextFingerprint,
			incrementalSendCount: record.sendState.incrementalSendCount,
		},
		createdAt: record.createdAt,
		...(storeIdentity ? { storeIdentity } : {}),
		state: parseBindingState(record.state),
		...(typeof record.agentInstanceId === "string" ? { agentInstanceId: record.agentInstanceId } : {}),
		...(typeof record.credentialScopeId === "string" && record.credentialScopeId
			? { credentialScopeId: record.credentialScopeId }
			: {}),
	};
}

function canSpanEntry(entry: ResumeSessionEntry, unownedUserEntryIds: ReadonlySet<string>): boolean {
	if (entry.type === "custom" || entry.type === "label" || entry.type === "session_init") return true;
	if (entry.type === "message" && entry.message?.role === "user") {
		return !unownedUserEntryIds.has(entry.id);
	}
	return false;
}

interface FoldState {
	branchPathHash: string;
	compactionGeneration: number;
	activeHandle?: ResumeEntryData;
}

function resumeLineageKey(data: ResumeEntryData): string {
	return JSON.stringify([data.agentId, data.scopeKey, data.sessionFile, data.sessionId, data.cwd, data.poolKey]);
}

function sameResumeCwd(left: string, right: string): boolean {
	return resolvePath(left) === resolvePath(right);
}

function parseResumeLine(value: unknown): ResumeEntryData | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (record.customType !== CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE && record.type !== CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE) {
		return undefined;
	}
	return parseResumeEntryData(record.data ?? record);
}

/** Latest on-disk resume record for this lineage must match the in-flight payload. */
export function sessionFileContainsResume(sessionFile: string, data: ResumeEntryData): boolean {
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return false;
	}
	let latest: ResumeEntryData | undefined;
	const lineage = resumeLineageKey(data);
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		const entry = parseResumeLine(parsed);
		if (!entry || resumeLineageKey(entry) !== lineage) continue;
		latest = entry;
	}
	return Boolean(
		latest && latest.state === data.state && latest.agentId === data.agentId && latest.createdAt === data.createdAt,
	);
}

function indexLatestResumeEntries(entries: readonly ResumeSessionEntry[]): {
	entryIds: Set<string>;
	latestEntryIdByLineage: Map<string, string>;
} {
	const entryIds = new Set<string>();
	const latestEntryIdByLineage = new Map<string, string>();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		entryIds.add(entry.id);
		if (entry.type !== "custom" || entry.customType !== CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE) continue;
		const data = parseResumeEntryData(entry.data);
		if (!data) continue;
		const lineage = resumeLineageKey(data);
		if (!latestEntryIdByLineage.has(lineage)) latestEntryIdByLineage.set(lineage, entry.id);
	}
	return { entryIds, latestEntryIdByLineage };
}

function matchesScope(data: ResumeEntryData, scope: ResumeScope): boolean {
	return data.scopeKey === scope.scopeKey && data.sessionFile === scope.sessionFile && data.sessionId === scope.sessionId;
}

function advanceFold(
	entry: ResumeSessionEntry,
	previous: FoldState,
	resumeIndex: { entryIds: Set<string>; latestEntryIdByLineage: Map<string, string> },
	scope: ResumeScope,
	unownedUserEntryIds: ReadonlySet<string>,
): FoldState {
	if (entry.type === "custom" && entry.customType === CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE) {
		const data = parseResumeEntryData(entry.data);
		const latestEntryId = data ? resumeIndex.latestEntryIdByLineage.get(resumeLineageKey(data)) : undefined;
		const superseded = resumeIndex.entryIds.has(entry.id) && latestEntryId !== entry.id;
		if (
			data &&
			matchesScope(data, scope) &&
			data.compactionGeneration === previous.compactionGeneration &&
			data.branchPathHash === previous.branchPathHash &&
			!superseded
		) {
			return { ...previous, activeHandle: data };
		}
		return previous;
	}
	return {
		branchPathHash: hashBranchStep(previous.branchPathHash, entry),
		compactionGeneration: entry.type === "compaction" ? previous.compactionGeneration + 1 : previous.compactionGeneration,
		activeHandle: previous.activeHandle && !canSpanEntry(entry, unownedUserEntryIds) ? undefined : previous.activeHandle,
	};
}

export function foldResumeHandle(
	branch: readonly ResumeSessionEntry[],
	scope: ResumeScope,
	unownedUserEntryIds: ReadonlySet<string> = new Set(),
	allEntries: readonly ResumeSessionEntry[] = branch,
): FoldState {
	const resumeIndex = indexLatestResumeEntries(allEntries);
	let fold: FoldState = { branchPathHash: EMPTY_BRANCH_HASH, compactionGeneration: 0 };
	for (const entry of branch) {
		fold = advanceFold(entry, fold, resumeIndex, scope, unownedUserEntryIds);
	}
	return fold;
}

const states = new WeakMap<CursorSessionOwner, ResumeState>();

function getResumeState(): ResumeState {
	const owner = getCursorSessionOwner();
	let state = states.get(owner);
	if (!state) {
		state = {
			scopeKey: owner.scopeKey,
			sessionFile: owner.sessionFile,
			sessionId: owner.sessionId,
			cwd: owner.cwd,
			branchPathHash: EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			unownedUserEntryIds: new Set(),
		};
		states.set(owner, state);
	}
	return state;
}

function restoreFromBranch(branch: readonly ResumeSessionEntry[], allEntries: readonly ResumeSessionEntry[] = branch): void {
	const state = getResumeState();
	const fold = foldResumeHandle(branch, state, state.unownedUserEntryIds, allEntries);
	state.branchPathHash = fold.branchPathHash;
	state.compactionGeneration = fold.compactionGeneration;
	state.activeHandle = fold.activeHandle;
}

export function getResumeCompactionGeneration(): number {
	const state = getResumeState();
	return state.compactionGeneration;
}

export function getResumeBranchPathHash(): string {
	const state = getResumeState();
	return state.branchPathHash;
}

export function getMatchingResumeHandle(
	poolKey: string,
	credentialScopeId?: string,
	cwd = getResumeState().cwd,
): ResumeEntryData | undefined {
	const state = getResumeState();
	const handle = state.activeHandle;
	if (!handle || !isLocalAgentId(handle.agentId)) return undefined;
	if (handle.state !== "committed") return undefined;
	if (handle.poolKey !== poolKey) return undefined;
	if (handle.scopeKey !== state.scopeKey) return undefined;
	if (handle.sessionFile !== state.sessionFile) return undefined;
	if (handle.sessionId !== state.sessionId) return undefined;
	if (!sameResumeCwd(handle.cwd, cwd)) return undefined;
	if (handle.compactionGeneration !== state.compactionGeneration) return undefined;
	if (!handle.credentialScopeId || !credentialScopeId || handle.credentialScopeId !== credentialScopeId) return undefined;
	return {
		...handle,
		sendState: { ...handle.sendState },
	};
}

export function persistResumeHandle(input: PendingResumeHandle): void {
	const state = getResumeState();
	if (!getCursorSessionOwner().persistent) return;
	if (!isLocalAgentId(input.agentId)) return;
	state.pendingHandle = {
		agentId: input.agentId,
		poolKey: input.poolKey,
		sendState: { ...input.sendState },
		storeIdentity: { ...input.storeIdentity },
		state: input.state,
		agentInstanceId: input.agentInstanceId,
		cwd: resolvePath(input.cwd),
		...(input.credentialScopeId ? { credentialScopeId: input.credentialScopeId } : {}),
	};
}

function resumeEntryFromPending(pending: PendingResumeHandle): ResumeEntryData {
	const state = getResumeState();
	return {
		version: RESUME_ENTRY_VERSION,
		runtime: "local",
		agentId: pending.agentId,
		scopeKey: state.scopeKey,
		...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
		...(state.sessionId ? { sessionId: state.sessionId } : {}),
		cwd: pending.cwd,
		poolKey: pending.poolKey,
		branchPathHash: state.branchPathHash,
		compactionGeneration: state.compactionGeneration,
		sendState: { ...pending.sendState },
		createdAt: new Date().toISOString(),
		storeIdentity: { ...pending.storeIdentity },
		state: pending.state,
		agentInstanceId: pending.agentInstanceId,
		...(pending.credentialScopeId ? { credentialScopeId: pending.credentialScopeId } : {}),
	};
}

/**
 * Persist a resume record immediately. Used to invalidate a previous committed
 * binding before the SDK agent is advanced. Failure must not start send.
 */
export function flushResumeHandleNow(input: PendingResumeHandle): void {
	const state = getResumeState();
	if (!getCursorSessionOwner().persistent) return;
	if (!isLocalAgentId(input.agentId)) {
		throw new Error("Cannot persist a Cursor SDK resume handle without a local agent id");
	}
	persistResumeHandle(input);
	if (!state.appendEntry) {
		throw new Error("Cannot persist Cursor SDK resume invalidation without a session appendEntry hook");
	}
	const pending = state.pendingHandle;
	if (!pending) {
		throw new Error("Cannot persist Cursor SDK resume invalidation without a pending handle");
	}
	state.pendingHandle = undefined;
	const data = resumeEntryFromPending(pending);
	if (!state.sessionFile) {
		throw new Error("Cannot persist Cursor SDK resume invalidation without a session file");
	}
	state.appendEntry<ResumeEntryData>(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, data);
	if (!sessionFileContainsResume(state.sessionFile, data)) {
		throw new Error("Cursor SDK resume invalidation was not persisted to the session file");
	}
	state.activeHandle = data;
}

function flushPendingHandle(branch: readonly ResumeSessionEntry[]): void {
	const state = getResumeState();
	restoreFromBranch(branch);
	const pending = state.pendingHandle;
	state.pendingHandle = undefined;
	if (!pending || !state.appendEntry) return;
	const data = resumeEntryFromPending(pending);
	try {
		state.appendEntry<ResumeEntryData>(CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE, data);
		state.activeHandle = data;
	} catch {
		// Committed flush is after the turn; in-flight invalidation already landed.
	}
}

function restoreFromSessionManager(sessionManager: {
	getBranch(): ResumeSessionEntry[];
	getEntries(): ResumeSessionEntry[];
}): void {
	const branch = sessionManager.getBranch();
	const entries = sessionManager.getEntries();
	restoreFromBranch(branch, entries.length > 0 ? entries : branch);
}

export function registerCursorSessionResume(pi: Pick<ExtensionAPI, "on" | "appendEntry">): void {
	const on = sessionEvents(pi);
	on("session_start", (_event, ctx) => {
		const state = getResumeState();
		// Capture the extension writer and its session identity together.
		const sessionId = ctx.sessionManager.getSessionId?.();
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		state.appendEntry = (customType, data) => {
			if (ctx.sessionManager.getSessionId?.() !== sessionId || ctx.sessionManager.getSessionFile?.() !== sessionFile) {
				throw new Error("Cannot persist Cursor SDK resume state after its session changed");
			}
			pi.appendEntry(customType, data);
		};
		state.scopeKey = getCursorSessionScopeKey();
		state.sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
		state.sessionId = ctx.sessionManager.getSessionId?.() ?? undefined;
		state.cwd = ctx.cwd;
		state.unownedUserEntryIds = new Set(
			ctx.sessionManager.getBranch().flatMap((entry) =>
				entry.type === "message" && "message" in entry && entry.message.role === "user" ? [entry.id] : [],
			),
		);
		restoreFromSessionManager(ctx.sessionManager);
	});
	on("before_agent_start", (_event, ctx) => {
		restoreFromSessionManager(ctx.sessionManager);
	});
	on("turn_end", (_event, ctx) => {
		flushPendingHandle(ctx.sessionManager.getBranch());
	});
	on("session_tree", (_event, ctx) => {
		const state = getResumeState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && "message" in entry && entry.message.role === "user") {
				state.unownedUserEntryIds.add(entry.id);
			}
		}
		restoreFromSessionManager(ctx.sessionManager);
	});
	on("session_compact", (event, ctx) => {
		const state = getResumeState();
		state.pendingHandle = undefined;
		const branch = ctx.sessionManager.getBranch();
		if (branch.length > 0) {
			restoreFromSessionManager(ctx.sessionManager);
			return;
		}
		state.activeHandle = undefined;
		state.compactionGeneration += 1;
		state.branchPathHash = hashBranchStep(state.branchPathHash, event.compactionEntry);
	});
}

export function clearResumeHandle(): void {
	const state = getResumeState();
	state.activeHandle = undefined;
	state.pendingHandle = undefined;
}

export const __testUtils = {
	EMPTY_BRANCH_HASH,
	reset() {
		const state = getResumeState();
		state.appendEntry = undefined;
		state.scopeKey = getCursorSessionScopeKey();
		state.sessionFile = undefined;
		state.sessionId = undefined;
		state.cwd = process.cwd();
		state.branchPathHash = EMPTY_BRANCH_HASH;
		state.compactionGeneration = 0;
		state.activeHandle = undefined;
		state.pendingHandle = undefined;
		state.unownedUserEntryIds = new Set();
	},
	get state() { return getResumeState(); },
};
