import { resolve as resolvePath } from "node:path";
import type { LocalAgentStore, ModelSelection, SDKAgent, SDKCustomTool, SDKUserMessage } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { credentialScopeId } from "./auth.js";
import { DEFAULT_AGENT_INSTANCE_ID } from "./constants.js";
import type { BindingState, GrantedTool, OmpHostBridgeV1 } from "./contracts.js";
import { computeContextFingerprint, emptySendState, locatorFor, locatorsMatch, planSend, prepareSendInput, type MessageLocator, type ModelInputLimits, type SendState } from "./context.js";
import { createSharedToolExec, type SharedToolExec } from "./host-exec.js";
import {
	createLiveRun,
	disposeAgent,
	disposeLiveRun,
	getLiveRun,
	liveRunKey,
	parkToolCall,
	setLiveRun,
	type LiveRun,
} from "./live-run.js";
import { trailingToolResults } from "./omp-tools.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";
import { createSummaryBoundaryProbe, type SummaryBoundaryProbe } from "./native-history.js";
import { nativeSdkToolsFromGrants, nativeToolsFingerprint, isHookedOmpTool } from "./sdk-native-hook.js";
import { openAgent, prewarmLocalExecutor, type OpenAgentInput } from "./sdk-session.js";
import { flushResumeHandleNow, getMatchingResumeHandle, persistResumeHandle, type ResumeStoreIdentity } from "./session-resume.js";
import { getCursorSessionCwd, getCursorSessionOwner, getCursorSessionScopeKey, withCursorSessionOwner, type CursorSessionOwner } from "./session-scope.js";
import { observeLocalAgentStore, openScopedJsonlStore, storeRootForScope } from "./store.js";
import { buildCustomTools, newBridgeRunId } from "./tools.js";
import { ompToolCallId } from "./projector.js";

export interface RuntimeSlot {
	key: string;
	owner: CursorSessionOwner;
	scopeKey: string;
	agentInstanceId: string;
	cwd: string;
	createCwd?: string;
	credentialScopeId?: string;
	includeWebSearch?: boolean;
	nativeTools?: string;
	agent?: SDKAgent;
	sendState: SendState;
	bindingState: BindingState;
	storeIdentity: ResumeStoreIdentity;
	store?: LocalAgentStore;
	summaryProbe?: SummaryBoundaryProbe;
	preparation?: AbortController;
	committedContextTail?: MessageLocator;
	pendingNativeRebase?: PendingNativeRebase;
}

export interface PendingNativeRebase {
	materializationId: string;
	compactionEntryId: string;
	compactionTimestamp: number;
	checkpointRootBlobId: string;
	summaryGeneration: number;
	archiveHash: string;
	knownTailLocator?: MessageLocator;
}

export interface NativeRebaseResult {
	compactionEntryId: string;
	effectiveHistoryDigest: string;
}

const slots = new Map<string, RuntimeSlot>();
let openAgentImpl: (input: OpenAgentInput) => Promise<SDKAgent> = openAgent;
let prewarmImpl: typeof prewarmLocalExecutor = prewarmLocalExecutor;

interface ExecutorLease {
	fingerprint: string;
	release: Promise<() => Promise<void>>;
}
/** scopeKey → held SDK executor lease; keeps the workspace runtime warm across agent disposals. */
const executorLeases = new Map<string, ExecutorLease>();

/** Start (or keep) the SDK local executor for this scope's cwd + credential. Failures are ignored; `send()` rebuilds. */
export function warmLocalExecutor(cwd: string, apiKey: string, modelId: string, scopeKey = getCursorSessionScopeKey()): void {
	cwd = normalizeRuntimeCwd(cwd);
	const fingerprint = `${cwd}\0${credentialScopeId(apiKey)}`;
	const current = executorLeases.get(scopeKey);
	if (current?.fingerprint === fingerprint) return;
	if (current) void releaseExecutorLease(scopeKey);
	const release = withSdkExitSuppressed(() =>
		prewarmImpl({ apiKey, cwd, model: { id: modelId }, store: openScopedJsonlStore(cwd, scopeKey) }),
	);
	release.catch(() => undefined);
	executorLeases.set(scopeKey, { fingerprint, release });
}

function releaseExecutorLease(scopeKey: string): Promise<void> {
	const lease = executorLeases.get(scopeKey);
	if (!lease) return Promise.resolve();
	executorLeases.delete(scopeKey);
	return lease.release.then((release) => withSdkExitSuppressed(release), () => undefined);
}

export function runtimeKey(scopeKey = getCursorSessionScopeKey(), agentInstanceId = DEFAULT_AGENT_INSTANCE_ID): string {
	return liveRunKey(scopeKey, agentInstanceId);
}

export function getRuntimeSlot(key: string): RuntimeSlot | undefined {
	return slots.get(key);
}

export function listRuntimeSlots(): RuntimeSlot[] {
	const owner = getCursorSessionOwner();
	const result: RuntimeSlot[] = [];
	for (const slot of slots.values()) {
		if (slot.owner === owner) result.push(slot);
	}
	return result;
}

/** Snapshot process-known live agents for one credential, independent of session ownership. */
export function listCredentialUsageAgents(scopeId: string): Array<{ agent: SDKAgent; agentInstanceId: string }> {
	const agents = new Map<string, { agent: SDKAgent; agentInstanceId: string }>();
	for (const slot of slots.values()) {
		if (slot.credentialScopeId !== scopeId || !slot.agent || agents.has(slot.agent.agentId)) continue;
		agents.set(slot.agent.agentId, { agent: slot.agent, agentInstanceId: slot.agentInstanceId });
	}
	return [...agents.values()];
}

export function normalizeRuntimeCwd(cwd: string): string {
	return resolvePath(cwd);
}

export function agentConfigMismatch(slot: RuntimeSlot, cwd: string, nextCredentialScopeId: string): boolean {
	if (!slot.agent) return false;
	return slotIdentityMismatch(slot, cwd, nextCredentialScopeId);
}

export function slotIdentityMismatch(slot: RuntimeSlot, cwd: string, nextCredentialScopeId: string): boolean {
	if (!slot.createCwd || !slot.credentialScopeId) return true;
	return normalizeRuntimeCwd(slot.createCwd) !== normalizeRuntimeCwd(cwd) || slot.credentialScopeId !== nextCredentialScopeId;
}

function grantMismatch(slot: RuntimeSlot, includeWebSearch: boolean | undefined, nativeTools: string): boolean {
	return Boolean(slot.includeWebSearch) !== Boolean(includeWebSearch) || (slot.nativeTools ?? "") !== nativeTools;
}

function getOrCreateSlot(scopeKey: string, agentInstanceId: string, cwd: string): RuntimeSlot {
	const key = runtimeKey(scopeKey, agentInstanceId);
	const existing = slots.get(key);
	if (existing) return existing;
	const slot: RuntimeSlot = {
		key,
		owner: getCursorSessionOwner(),
		scopeKey,
		agentInstanceId,
		cwd,
		sendState: emptySendState(),
		bindingState: "dirty",
		storeIdentity: { version: 1, stateRoot: storeRootForScope(cwd, scopeKey) },
	};
	slots.set(key, slot);
	return slot;
}

export interface OpenRuntimeTurnInput {
	cwd: string;
	agentInstanceId: string;
	apiKey: string;
	modelSelection?: ModelSelection;
	modelLimits: ModelInputLimits;
	context: Context;
	grantedTools: readonly GrantedTool[];
	includeWebSearch?: boolean;
	host?: OmpHostBridgeV1;
	signal?: AbortSignal;
}

export interface PreparedTurn {
	slot: RuntimeSlot;
	live: LiveRun;
	continuing: boolean;
	customTools: Record<string, SDKCustomTool>;
	prompt?: SDKUserMessage;
	incremental: boolean;
	nativeRebase?: NativeRebaseResult;
}

function attachParkExecutor(live: LiveRun, grantedTools: readonly GrantedTool[], host?: OmpHostBridgeV1): SharedToolExec {
	const exec = createSharedToolExec(grantedTools, (name, args, sdkToolCallId) => {
		if (live.cancelled) throw new Error("Cursor SDK live run was cancelled");
		const ompId = ompToolCallId(live.projection, sdkToolCallId);
		if (host) return host.executeTool(name, args, ompId);
		return parkToolCall(live, name, args, sdkToolCallId, ompId);
	}, live.toolExec.bridgeRunId);
	live.toolExec = exec;
	return exec;
}

function resumePending(slot: RuntimeSlot, state: BindingState) {
	if (!slot.agent || !slot.createCwd) return undefined;
	return {
		agentId: slot.agent.agentId,
		poolKey: slot.agentInstanceId,
		sendState: { ...slot.sendState },
		storeIdentity: slot.storeIdentity,
		state,
		agentInstanceId: slot.agentInstanceId,
		cwd: slot.createCwd,
		...(slot.credentialScopeId ? { credentialScopeId: slot.credentialScopeId } : {}),
	};
}

function persistDirtyHandle(slot: RuntimeSlot, handle: {
	agentId: string;
	sendState: SendState;
	storeIdentity?: ResumeStoreIdentity;
	credentialScopeId?: string;
	cwd: string;
}): void {
	const dirty = {
		agentId: handle.agentId,
		poolKey: slot.agentInstanceId,
		sendState: { ...handle.sendState },
		storeIdentity: handle.storeIdentity ?? slot.storeIdentity,
		state: "dirty" as const,
		agentInstanceId: slot.agentInstanceId,
		cwd: handle.cwd,
		...(handle.credentialScopeId ? { credentialScopeId: handle.credentialScopeId } : {}),
	};
	try {
		withCursorSessionOwner(slot.owner, () => flushResumeHandleNow(dirty));
	} catch {
		withCursorSessionOwner(slot.owner, () => persistResumeHandle(dirty));
	}
}

/** Resets slot state synchronously; the returned agent disposal may run concurrently with the next open. */
function persistDirtyAndDisposeAgent(slot: RuntimeSlot): Promise<void> {
	const dirty = resumePending(slot, "dirty");
	if (dirty) persistDirtyHandle(slot, dirty);
	const agent = slot.agent;
	slot.agent = undefined;
	slot.bindingState = "dirty";
	slot.createCwd = undefined;
	slot.credentialScopeId = undefined;
	slot.sendState = emptySendState();
	slot.store = undefined;
	slot.summaryProbe = undefined;
	slot.committedContextTail = undefined;
	slot.pendingNativeRebase = undefined;
	return agent ? disposeAgent(agent) : Promise.resolve();
}

function invalidateBindingBeforeSend(slot: RuntimeSlot, agentId: string): void {
	if (!slot.createCwd) {
		throw new Error("Cannot invalidate a Cursor SDK binding without the agent's execution cwd");
	}
	withCursorSessionOwner(slot.owner, () => flushResumeHandleNow({
		agentId,
		poolKey: slot.agentInstanceId,
		sendState: { ...slot.sendState },
		storeIdentity: slot.storeIdentity,
		state: "in-flight",
		agentInstanceId: slot.agentInstanceId,
		cwd: slot.createCwd!,
		...(slot.credentialScopeId ? { credentialScopeId: slot.credentialScopeId } : {}),
	}));
	slot.bindingState = "in-flight";
}

export function markPersistedHandleDirtyPreservingAgent(slot: RuntimeSlot): void {
	if (slots.get(slot.key) !== slot) return;
	const dirty = resumePending(slot, "dirty");
	if (dirty) persistDirtyHandle(slot, dirty);
}

function findUniqueMessageIndex(messages: Context["messages"], locator: MessageLocator): number | undefined {
	const matches: number[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		if (locatorsMatch(locatorFor(messages[index]), locator)) matches.push(index);
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export function attemptNativeCompactionRebase(slot: RuntimeSlot, context: Context): NativeRebaseResult | undefined {
	const pending = slot.pendingNativeRebase;
	if (!pending) return;
	const summaryIndex = context.messages.findIndex((message) => (
		message.role === "user"
		&& "historyRewriteAt" in message
		&& message.historyRewriteAt === pending.compactionTimestamp
	));
	if (summaryIndex < 0 || !pending.knownTailLocator) {
		slot.pendingNativeRebase = undefined;
		return;
	}
	const knownTailIndex = findUniqueMessageIndex(context.messages, pending.knownTailLocator);
	if (knownTailIndex === undefined || knownTailIndex < summaryIndex) {
		slot.pendingNativeRebase = undefined;
		return;
	}
	const rebasedPrefix = { ...context, messages: context.messages.slice(0, knownTailIndex + 1) };
	const rebasedFingerprint = computeContextFingerprint(rebasedPrefix);
	// Refuse rebase when system prompt changed — keep old sendState so planSend bootstraps.
	try {
		const previous = JSON.parse(slot.sendState.contextFingerprint) as { systemHash?: unknown };
		const next = JSON.parse(rebasedFingerprint) as { systemHash?: unknown };
		if (
			typeof previous.systemHash === "string"
			&& typeof next.systemHash === "string"
			&& previous.systemHash !== next.systemHash
		) {
			slot.pendingNativeRebase = undefined;
			return;
		}
	} catch {
		slot.pendingNativeRebase = undefined;
		return;
	}
	slot.sendState = {
		bootstrapped: true,
		contextFingerprint: rebasedFingerprint,
		incrementalSendCount: 0,
	};
	slot.pendingNativeRebase = undefined;
	return {
		compactionEntryId: pending.compactionEntryId,
		effectiveHistoryDigest: slot.sendState.contextFingerprint,
	};
}

export async function prepareTurn(input: OpenRuntimeTurnInput): Promise<PreparedTurn> {
	input.signal?.throwIfAborted();
	const scopeKey = getCursorSessionScopeKey();
	const cwd = normalizeRuntimeCwd(input.cwd || getCursorSessionCwd());
	const nextCredential = credentialScopeId(input.apiKey);
	let slot = getOrCreateSlot(scopeKey, input.agentInstanceId, cwd);
	const existingLive = getLiveRun(slot.key);
	const trailing = trailingToolResults(input.context);
	const continuing = Boolean(existingLive && trailing.length > 0);

	if (existingLive && continuing) {
		const nextNativeTools = nativeToolsFingerprint(input.grantedTools.map((tool) => tool.name));
		if (slotIdentityMismatch(slot, cwd, nextCredential) || grantMismatch(slot, input.includeWebSearch, nextNativeTools)) {
			await finishTurnFailed(slot, "tool grant or identity changed during parked tool calls");
			throw new Error(
				slotIdentityMismatch(slot, cwd, nextCredential)
					? "Cannot continue parked Cursor SDK tool calls after cwd or credentials changed"
					: Boolean(slot.includeWebSearch) !== Boolean(input.includeWebSearch)
						? "Cannot continue parked Cursor SDK tool calls after webSearch grant changed"
						: "Cannot continue parked Cursor SDK tool calls after native tool grants changed",
			);
		}
		return { slot, live: existingLive, continuing: true, customTools: {}, incremental: true };
	}

	const modelSelection = input.modelSelection;
	if (!modelSelection) {
		throw new Error("Cannot open a Cursor SDK agent without a model selection");
	}

	const nextNativeTools = nativeToolsFingerprint(input.grantedTools.map((tool) => tool.name));
	const configMismatch = agentConfigMismatch(slot, cwd, nextCredential)
		|| Boolean(slot.agent) && grantMismatch(slot, input.includeWebSearch, nextNativeTools);
	const unsafeBinding = Boolean(slot.agent) && (slot.bindingState !== "committed" || configMismatch);
	const resumeHandle = unsafeBinding ? undefined : getMatchingResumeHandle(input.agentInstanceId, nextCredential, cwd);
	const sendState = unsafeBinding ? emptySendState() : slot.agent ? slot.sendState : resumeHandle?.sendState ?? emptySendState();
	const plannedSlot: RuntimeSlot = { ...slot, sendState: { ...sendState } };
	const nativeRebase = !unsafeBinding && trailing.length === 0 && plannedSlot.pendingNativeRebase
		? attemptNativeCompactionRebase(plannedSlot, input.context)
		: undefined;
	const plan = trailing.length > 0
		? { mode: "bootstrap" as const, resetAgent: true, reason: "context_divergence" as const }
		: planSend(plannedSlot.sendState, input.context);
	const { prompt, history } = prepareSendInput(plan, input.context, input.modelLimits, modelSelection.id);
	if (!unsafeBinding) {
		slot.sendState = { ...plannedSlot.sendState };
		slot.pendingNativeRebase = plannedSlot.pendingNativeRebase;
	}

	slot.preparation?.abort();
	const preparation = new AbortController();
	slot = { ...slot, preparation };
	slots.set(slot.key, slot);
	const signal = input.signal ? AbortSignal.any([input.signal, preparation.signal]) : preparation.signal;
	const assertCurrent = () => {
		signal.throwIfAborted();
		if (slots.get(slot.key) !== slot) throw new Error("Cursor SDK preparation was superseded");
	};
	try {
		if (unsafeBinding) void persistDirtyAndDisposeAgent(slot);
		if (existingLive) {
			await disposeLiveRun(slot.key, "OMP started a new user turn", false);
			assertCurrent();
		}
		if (resumeHandle && !slot.agent) {
			slot.sendState = { ...resumeHandle.sendState };
			slot.bindingState = "committed";
			slot.createCwd = resumeHandle.cwd;
			slot.credentialScopeId = resumeHandle.credentialScopeId;
			slot.storeIdentity = resumeHandle.storeIdentity ?? slot.storeIdentity;
		} else if (!slot.agent) {
			slot.sendState = emptySendState();
		}
		if (plan.resetAgent) {
			if (slot.agent) {
				void persistDirtyAndDisposeAgent(slot);
			} else if (resumeHandle) {
				persistDirtyHandle(slot, resumeHandle);
				slot.bindingState = "dirty";
				slot.createCwd = undefined;
				slot.credentialScopeId = undefined;
				slot.sendState = emptySendState();
			}
		}

		const savedAgentId = slot.agent?.agentId ?? (slot.bindingState === "committed" ? resumeHandle?.agentId : undefined);
		if (!slot.store || !slot.summaryProbe) {
			const inner = openScopedJsonlStore(cwd, scopeKey);
			const summaryProbe = createSummaryBoundaryProbe(inner);
			slot.summaryProbe = summaryProbe;
			slot.store = observeLocalAgentStore(inner, (event) => {
				if (event.kind === "agents.write") summaryProbe.onAgentUpdated(event.agent);
				else if (event.kind === "runEvents.append") summaryProbe.onRunEvent(event);
			});
		}
		const store = slot.store;
		slot.storeIdentity = { version: 1, stateRoot: storeRootForScope(cwd, scopeKey) };

		const reuseId = savedAgentId ?? slot.agent?.agentId;
		if (reuseId) {
			invalidateBindingBeforeSend(slot, reuseId);
		}

		const live = createLiveRun(createSharedToolExec(input.grantedTools, async () => {
			throw new Error("tool executor is not attached");
		}, newBridgeRunId()));
		const toolExec = attachParkExecutor(live, input.grantedTools, input.host);
		const sdkToOmp = new Map<string, string>();
		const grantedNames = input.grantedTools.map((tool) => tool.name);
		const customGranted = input.grantedTools.filter((tool) => !isHookedOmpTool(tool.name, grantedNames));
		const customTools = buildCustomTools(customGranted, toolExec.execute, toolExec.dedupe, sdkToOmp);
		live.projection.sdkToOmp = sdkToOmp;
		live.projection.allowToolPreview = !input.host;

		if (!slot.agent) {
			const agent = await withSdkExitSuppressed(() =>
				openAgentImpl({
					apiKey: input.apiKey,
					cwd,
					model: modelSelection,
					store,
					customTools,
					includeWebSearch: input.includeWebSearch,
					includeNativeTools: nativeSdkToolsFromGrants(grantedNames),
					savedAgentId,
					...(!savedAgentId ? { bootstrapHistory: history } : {}),
					signal,
				}),
			);
			if (signal.aborted || slots.get(slot.key) !== slot) {
				await disposeAgent(agent);
				assertCurrent();
			}
			slot.agent = agent;
			slot.createCwd = cwd;
			slot.credentialScopeId = nextCredential;
			slot.includeWebSearch = Boolean(input.includeWebSearch);
			slot.nativeTools = nextNativeTools;
		}
		live.agent = slot.agent;
		live.checkpointStore = store;
		live.summaryProbe = slot.summaryProbe;
		setLiveRun(slot.key, live);
		slot.bindingState = "in-flight";
		slot.cwd = cwd;
		slot.credentialScopeId = nextCredential;
		slot.includeWebSearch = Boolean(input.includeWebSearch);
		slot.nativeTools = nextNativeTools;

		return {
			slot,
			live,
			continuing: false,
			customTools,
			prompt,
			incremental: plan.mode === "incremental",
			...(nativeRebase ? { nativeRebase } : {}),
		};
	} catch (error) {
		if (slots.get(slot.key) === slot) await persistDirtyAndDisposeAgent(slot);
		throw error;
	}
}

export function commitTurn(slot: RuntimeSlot, context: Context, incremental: boolean): void {
	if (slots.get(slot.key) !== slot || slot.preparation?.signal.aborted || getLiveRun(slot.key)?.cancelled) return;
	slot.sendState = {
		bootstrapped: true,
		contextFingerprint: computeContextFingerprint(context),
		incrementalSendCount: incremental ? slot.sendState.incrementalSendCount + 1 : 0,
	};
	const last = context.messages.at(-1);
	slot.committedContextTail = last ? locatorFor(last) : undefined;
	slot.bindingState = "committed";
	const pending = resumePending(slot, "committed");
	if (pending) withCursorSessionOwner(slot.owner, () => persistResumeHandle(pending));
}

export function markTurnDirty(slot: RuntimeSlot): void {
	if (slots.get(slot.key) !== slot) return;
	slot.preparation?.abort();
	slot.bindingState = "dirty";
	const dirty = resumePending(slot, "dirty");
	if (dirty) {
		try {
			withCursorSessionOwner(slot.owner, () => flushResumeHandleNow(dirty));
		} catch {
			withCursorSessionOwner(slot.owner, () => persistResumeHandle(dirty));
		}
	}
	slot.agent = undefined;
	slot.sendState = emptySendState();
	slot.store = undefined;
	slot.summaryProbe = undefined;
	slot.committedContextTail = undefined;
	slot.pendingNativeRebase = undefined;
}

export async function finishLiveKeepAgent(slot: RuntimeSlot, reason: string): Promise<void> {
	if (slots.get(slot.key) !== slot) return;
	await disposeLiveRun(slot.key, reason, false);
}

export async function finishTurnFailed(slot: RuntimeSlot, reason: string): Promise<void> {
	if (slots.get(slot.key) !== slot) return;
	markTurnDirty(slot);
	await disposeLiveRun(slot.key, reason, true);
}

export function invalidateRuntime(_reason: string): void {
	for (const slot of slots.values()) {
		if (slot.owner !== getCursorSessionOwner()) continue;
		const agent = slot.agent;
		markTurnDirty(slot);
		slot.sendState = emptySendState();
		if (agent) void disposeAgent(agent);
	}
	for (const slot of slots.values()) {
		if (slot.owner !== getCursorSessionOwner()) continue;
		void disposeLiveRun(slot.key, "runtime invalidated", false);
	}
}

export async function disposeRuntimeForScope(scopeKey = getCursorSessionScopeKey()): Promise<void> {
	for (const [key, slot] of [...slots.entries()]) {
		if (slot.scopeKey !== scopeKey) continue;
		slot.preparation?.abort();
		slots.delete(key);
		await disposeLiveRun(key, "session scope closed", false);
		if (slot.agent) await disposeAgent(slot.agent);
	}
	await releaseExecutorLease(scopeKey);
}

export async function disposeRuntimeForShutdown(): Promise<void> {
	const pending = disposeRuntimeForScope();
	await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
}

export const __testUtils = {
	clear() {
		for (const slot of slots.values()) slot.preparation?.abort();
		slots.clear();
		executorLeases.clear();
		openAgentImpl = openAgent;
		prewarmImpl = prewarmLocalExecutor;
	},
	slots,
	executorLeases,
	/** Fake agents never own a real SDK executor, so prewarm becomes a no-op unless overridden. */
	setOpenAgent(fn: (input: OpenAgentInput) => Promise<SDKAgent>, prewarm: typeof prewarmLocalExecutor = async () => async () => undefined) {
		openAgentImpl = fn;
		prewarmImpl = prewarm;
	},
};
