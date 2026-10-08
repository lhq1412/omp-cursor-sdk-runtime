import { resolve as resolvePath } from "node:path";
import type { LocalAgentStore, ModelSelection, SDKAgent, SDKCustomTool, SDKUserMessage } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { credentialScopeId } from "./auth.js";
import { DEFAULT_AGENT_INSTANCE_ID } from "./constants.js";
import type { BindingState, GrantedTool, OmpHostBridgeV1 } from "./contracts.js";
import { computeContextFingerprint, deliveredAssistantDigest, emptySendState, locatorFor, locatorsMatch, parkedAssistantRewritten, planSend, prepareSendInput, type MessageLocator, type ModelInputLimits, type SendState } from "./context.js";
import { createSharedToolExec, type SharedToolExec } from "./host-exec.js";
import {
	createLiveRun,
	disposeAgent,
	disposeLiveRun,
	getLiveRun,
	liveRunKey,
	moveLiveRun,
	parkToolCall,
	setLiveRun,
	type LiveRun,
} from "./live-run.js";
import { trailingToolExchange } from "./omp-tools.js";
import { withSdkExitSuppressed } from "./sdk-exit-guard.js";
import { openAgent, prewarmLocalExecutor, type OpenAgentInput } from "./sdk-session.js";
import { flushResumeHandleNow, getMatchingResumeHandle, persistResumeHandle, type ResumeStoreIdentity } from "./session-resume.js";
import { getCursorSessionCwd, getCursorSessionOwner, getCursorSessionScopeKey, setCursorScopeRekeyHandler, withCursorSessionOwner, type CursorSessionOwner } from "./session-scope.js";
import { openScopedJsonlStore, openStoreAt, resolveStoreRoot, storeRootForScope } from "./store.js";
import { buildCustomTools, buildToolContract, estimateFormalToolDefinitionTokens, newBridgeRunId } from "./tools.js";
import { ompToolCallId } from "./projector.js";

export interface RuntimeSlot {
	key: string;
	owner: CursorSessionOwner;
	scopeKey: string;
	agentInstanceId: string;
	cwd: string;
	createCwd?: string;
	credentialScopeId?: string;
	toolContractFingerprint?: string;
	/** SDK 1.0.32 freezes the tool allowlist at create/resume. Empty grants omit `mcp`. */
	sdkMcpEnabled?: boolean;
	agent?: SDKAgent;
	sendState: SendState;
	bindingState: BindingState;
	storeIdentity: ResumeStoreIdentity;
	store?: LocalAgentStore;
	preparation?: AbortController;
	/**
	 * In-process consumption proof kept from prepare through the first `agent.send()` entry.
	 * Validated against cwd + credential on the next prepare; never authorizes agent reuse.
	 * Cleared only when send actually starts, or when identity/session invalidation drops it.
	 */
	preSendConsumption?: {
		sendState: SendState;
		cwd: string;
		credentialScopeId: string;
	};
	/** Set synchronously at the `agent.send()` entry; gates dirty vs keep-consumption on failure. */
	sendStarted?: boolean;
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

export function rekeyRuntimeScope(owner: CursorSessionOwner, fromScope: string, toScope: string): void {
	if (fromScope === toScope) return;
	for (const [key, slot] of [...slots.entries()]) {
		if (slot.owner !== owner || slot.scopeKey !== fromScope) continue;
		const nextKey = liveRunKey(toScope, slot.agentInstanceId);
		if (slots.has(nextKey) && slots.get(nextKey) !== slot) continue;
		slots.delete(key);
		moveLiveRun(key, nextKey);
		slot.scopeKey = toScope;
		slot.key = nextKey;
		slots.set(nextKey, slot);
	}
	if (executorLeases.has(fromScope) && !executorLeases.has(toScope)) {
		executorLeases.set(toScope, executorLeases.get(fromScope)!);
		executorLeases.delete(fromScope);
	}
}

setCursorScopeRekeyHandler(rekeyRuntimeScope);

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
	if (!slot.agent || !slot.createCwd || !slot.toolContractFingerprint) return undefined;
	return {
		agentId: slot.agent.agentId,
		poolKey: slot.agentInstanceId,
		sendState: { ...slot.sendState },
		storeIdentity: slot.storeIdentity,
		state,
		agentInstanceId: slot.agentInstanceId,
		cwd: slot.createCwd,
		toolContractFingerprint: slot.toolContractFingerprint,
		...(slot.credentialScopeId ? { credentialScopeId: slot.credentialScopeId } : {}),
	};
}

function persistDirtyHandle(slot: RuntimeSlot, handle: {
	agentId: string;
	sendState: SendState;
	storeIdentity?: ResumeStoreIdentity;
	credentialScopeId?: string;
	cwd: string;
	toolContractFingerprint?: string;
}): void {
	const toolContractFingerprint = slot.toolContractFingerprint ?? handle.toolContractFingerprint;
	if (!toolContractFingerprint) return;
	const dirty = {
		agentId: handle.agentId,
		poolKey: slot.agentInstanceId,
		sendState: { ...handle.sendState },
		storeIdentity: handle.storeIdentity ?? slot.storeIdentity,
		state: "dirty" as const,
		agentInstanceId: slot.agentInstanceId,
		cwd: handle.cwd,
		...(handle.credentialScopeId ? { credentialScopeId: handle.credentialScopeId } : {}),
		toolContractFingerprint,
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
	slot.toolContractFingerprint = undefined;
	slot.sendState = emptySendState();
	slot.store = undefined;
	return agent ? disposeAgent(agent) : Promise.resolve();
}

function invalidateBindingBeforeSend(slot: RuntimeSlot, agentId: string): void {
	if (!slot.createCwd || !slot.toolContractFingerprint) {
		throw new Error("Cannot invalidate a Cursor SDK binding without its execution cwd and tool contract");
	}
	const createCwd = slot.createCwd;
	const toolContractFingerprint = slot.toolContractFingerprint;
	withCursorSessionOwner(slot.owner, () => flushResumeHandleNow({
		agentId,
		poolKey: slot.agentInstanceId,
		sendState: { ...slot.sendState },
		storeIdentity: slot.storeIdentity,
		state: "in-flight",
		agentInstanceId: slot.agentInstanceId,
		cwd: createCwd,
		toolContractFingerprint,
		...(slot.credentialScopeId ? { credentialScopeId: slot.credentialScopeId } : {}),
	}));
	slot.bindingState = "in-flight";
}


function findUniqueMessageIndex(messages: Context["messages"], locator: MessageLocator): number | undefined {
	const matches: number[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		if (locatorsMatch(locatorFor(messages[index]), locator)) matches.push(index);
	}
	return matches.length === 1 ? matches[0] : undefined;
}


/** Dispose the in-memory agent without journaling dirty over a still-valid committed consumption record. */
function disposeAgentKeepJournalConsumption(slot: RuntimeSlot): Promise<void> {
	const agent = slot.agent;
	slot.agent = undefined;
	slot.bindingState = "dirty";
	slot.createCwd = undefined;
	slot.credentialScopeId = undefined;
	slot.toolContractFingerprint = undefined;
	slot.store = undefined;
	return agent ? disposeAgent(agent) : Promise.resolve();
}

function stashPreSendConsumption(
	slot: RuntimeSlot,
	sendState: SendState,
	cwd: string,
	credentialScopeId: string,
): void {
	slot.preSendConsumption = {
		sendState: { ...sendState },
		cwd: normalizeRuntimeCwd(cwd),
		credentialScopeId,
	};
	slot.sendState = { ...sendState };
}

function matchingPreSendConsumption(
	slot: RuntimeSlot,
	cwd: string,
	credentialScopeId: string,
): SendState | undefined {
	const proof = slot.preSendConsumption;
	if (!proof) return undefined;
	if (proof.credentialScopeId !== credentialScopeId) return undefined;
	if (normalizeRuntimeCwd(proof.cwd) !== normalizeRuntimeCwd(cwd)) return undefined;
	return { ...proof.sendState };
}

function clearPreSendConsumption(slot: RuntimeSlot): void {
	slot.preSendConsumption = undefined;
}

/**
 * Mark the turn as having crossed the real SDK send boundary.
 * Clears pre-send consumption so post-send failure uses dirty recovery only.
 * When a rebuild left a journal-committed consumption proof, persist in-flight for the new agent first.
 */
export function beginAgentSend(slot: RuntimeSlot): void {
	if (slots.get(slot.key) !== slot) return;
	if (slot.preSendConsumption && slot.agent) {
		invalidateBindingBeforeSend(slot, slot.agent.agentId);
	}
	slot.sendStarted = true;
	clearPreSendConsumption(slot);
}

export async function prepareTurn(input: OpenRuntimeTurnInput): Promise<PreparedTurn> {
	input.signal?.throwIfAborted();
	const scopeKey = getCursorSessionScopeKey();
	const cwd = normalizeRuntimeCwd(input.cwd || getCursorSessionCwd());
	const nextCredential = credentialScopeId(input.apiKey);
	const toolContract = buildToolContract(input.grantedTools);
	let slot = getOrCreateSlot(scopeKey, input.agentInstanceId, cwd);
	const existingLive = getLiveRun(slot.key);
	const exchange = trailingToolExchange(input.context);
	const trailing = exchange.results;
	const passive = exchange.passive;
	const parkedByOmpId = existingLive
		? new Map(existingLive.parked.map((call) => [call.ompToolCallId, call]))
		: undefined;
	const parkedMatch = Boolean(
		existingLive
		&& trailing.length > 0
		&& trailing.every((result) => parkedByOmpId?.get(result.toolCallId)?.name === result.toolName),
	);
	const continuing = parkedMatch && passive.length === 0;
	const assistantRewritten = parkedAssistantRewritten(existingLive?.deliveredAssistantDigest, input.context);
	if (existingLive && trailing.length > 0 && !parkedMatch) {
		const ownsContinuation = existingLive.requestLocator
			? findUniqueMessageIndex(input.context.messages, existingLive.requestLocator) !== undefined
			: false;
		if (existingLive.parked.length > 0 && ownsContinuation) {
			await finishTurnFailed(slot, "mismatched parked tool results");
		}
		throw new Error("OMP tool results do not match the current parked Cursor SDK calls");
	}

	if (existingLive && continuing && !assistantRewritten) {
		if (slotIdentityMismatch(slot, cwd, nextCredential) || slot.toolContractFingerprint !== toolContract.fingerprint) {
			await finishTurnFailed(slot, "tool contract or identity changed during parked tool calls");
			throw new Error(
				slotIdentityMismatch(slot, cwd, nextCredential)
					? "Cannot continue parked Cursor SDK tool calls after cwd or credentials changed"
					: "Cannot continue parked Cursor SDK tool calls after the OMP tool contract changed",
			);
		}
		return { slot, live: existingLive, continuing: true, customTools: {}, incremental: true };
	}

	const modelSelection = input.modelSelection;
	if (!modelSelection) {
		throw new Error("Cannot open a Cursor SDK agent without a model selection");
	}

	slot.sendStarted = false;
	const identityMismatch = agentConfigMismatch(slot, cwd, nextCredential);
	// Per-send local.customTools already carry the current catalog. Parked runs still freeze the contract above.
	const unsafeBinding = Boolean(slot.agent) && (slot.bindingState !== "committed" || identityMismatch);
	const resumeHandle = unsafeBinding
		? undefined
		: getMatchingResumeHandle(input.agentInstanceId, nextCredential, cwd);
	const consumptionHandle = getMatchingResumeHandle(input.agentInstanceId, nextCredential, cwd);
	const preservedSendState = (
		Boolean(slot.agent)
		&& slot.bindingState === "committed"
		&& !identityMismatch
	) ? { ...slot.sendState } : undefined;
	const memoryConsumption = matchingPreSendConsumption(slot, cwd, nextCredential);
	if (identityMismatch) clearPreSendConsumption(slot);
	const sendState = (() => {
		if (Boolean(slot.agent) && slot.bindingState !== "committed") return emptySendState();
		if (identityMismatch) return emptySendState();
		if (slot.agent) return { ...slot.sendState };
		return resumeHandle?.sendState
			?? consumptionHandle?.sendState
			?? memoryConsumption
			?? emptySendState();
	})();
	let plan = passive.length > 0
		? { mode: "bootstrap" as const, resetAgent: true, continueOnly: true as const, reason: "context_divergence" as const }
		: trailing.length > 0
			? { mode: "bootstrap" as const, resetAgent: true, reason: "context_divergence" as const }
			: planSend(sendState, input.context);
	const willReuseAgent = (Boolean(slot.agent) && !unsafeBinding) || Boolean(resumeHandle);
	if (!willReuseAgent && plan.mode === "incremental") {
		// Re-import natively; keep continueOnly so consumed input is not resent.
		plan = {
			mode: "bootstrap",
			resetAgent: true,
			reason: "context_divergence",
			...(plan.continueOnly ? { continueOnly: true as const } : {}),
		};
	}
	if (assistantRewritten && passive.length === 0) {
		plan = { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
	}
	const { prompt, history } = prepareSendInput(
		plan,
		input.context,
		input.modelLimits,
		modelSelection.id,
		toolContract.guidance,
		estimateFormalToolDefinitionTokens(toolContract.definitions),
	);
	if (!unsafeBinding) slot.sendState = { ...sendState };

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
		if (unsafeBinding) {
			clearPreSendConsumption(slot);
			void persistDirtyAndDisposeAgent(slot);
		}
		if (existingLive) {
			await disposeLiveRun(slot.key, "OMP started a new user turn", false);
			assertCurrent();
		}
		if (resumeHandle && !slot.agent) {
			clearPreSendConsumption(slot);
			slot.sendState = { ...resumeHandle.sendState };
			slot.bindingState = "committed";
			slot.createCwd = resumeHandle.cwd;
			slot.credentialScopeId = resumeHandle.credentialScopeId;
			slot.storeIdentity = resumeHandle.storeIdentity ?? slot.storeIdentity;
			slot.toolContractFingerprint = resumeHandle.toolContractFingerprint;
		} else if (!slot.agent) {
			const consumption = preservedSendState
				?? (consumptionHandle ? { ...consumptionHandle.sendState } : undefined)
				?? matchingPreSendConsumption(slot, cwd, nextCredential);
			if (!resumeHandle && !identityMismatch && consumption) {
				slot.sendState = consumption;
				// Keep journal/memory consumption until agent.send starts (cancel during baseline must not wipe it).
				if (consumption.bootstrapped) {
					stashPreSendConsumption(slot, consumption, cwd, nextCredential);
				}
			} else {
				slot.sendState = emptySendState();
			}
		}
		if (plan.resetAgent) {
			if (slot.agent) {
				clearPreSendConsumption(slot);
				void persistDirtyAndDisposeAgent(slot);
			} else if (resumeHandle) {
				clearPreSendConsumption(slot);
				persistDirtyHandle(slot, resumeHandle);
				slot.bindingState = "dirty";
				slot.createCwd = undefined;
				slot.credentialScopeId = undefined;
				slot.toolContractFingerprint = undefined;
				slot.sendState = emptySendState();
			}
		}

		let mcpResumeId: string | undefined;
		if (slot.agent && slot.sdkMcpEnabled !== true && input.grantedTools.length > 0) {
			mcpResumeId = slot.agent.agentId;
			const retiring = slot.agent;
			slot.agent = undefined;
			await disposeLiveRun(slot.key, "SDK tool capability changed", false);
			await disposeAgent(retiring);
		}
		const savedAgentId = mcpResumeId
			?? slot.agent?.agentId
			?? (slot.bindingState === "committed" ? resumeHandle?.agentId : undefined);
		if (!slot.store) {
			const journalRoot = resumeHandle?.storeIdentity?.stateRoot ?? slot.storeIdentity.stateRoot;
			const stateRoot = resolveStoreRoot(cwd, scopeKey, journalRoot);
			slot.store = openStoreAt(stateRoot);
			slot.storeIdentity = { version: 1, stateRoot };
		}
		const store = slot.store;

		const reuseId = savedAgentId ?? slot.agent?.agentId;
		if (reuseId) {
			invalidateBindingBeforeSend(slot, reuseId);
		}

		const live = createLiveRun(createSharedToolExec(input.grantedTools, async () => {
			throw new Error("tool executor is not attached");
		}, newBridgeRunId()));
		// Passive rebuild must be addressed by its own developer message. Pointing the
		// locator at the previous assistant makes a late result of that call cancel this run.
		const requestMessage = passive.length > 0
			? input.context.messages.at(-1)
			: input.context.messages.at(-trailing.length - 1);
		live.requestLocator = requestMessage ? locatorFor(requestMessage) : undefined;
		const toolExec = attachParkExecutor(live, input.grantedTools, input.host);
		const customTools = buildCustomTools(toolContract, toolExec.execute);
		live.projection.sdkToOmp = new Map(toolContract.sdkToOmp);
		live.projection.allowToolPreview = !input.host;

		if (!slot.agent) {
			const agent = await withSdkExitSuppressed(() =>
				openAgentImpl({
					apiKey: input.apiKey,
					cwd,
					model: modelSelection,
					store,
					customTools,
					toolNameMap: toolContract.ompToSdk,
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
			slot.sdkMcpEnabled = Object.keys(customTools).length > 0;
			slot.createCwd = cwd;
			slot.credentialScopeId = nextCredential;
			slot.toolContractFingerprint = toolContract.fingerprint;
		}
		live.agent = slot.agent;
		live.checkpointStore = store;
		setLiveRun(slot.key, live);
		slot.bindingState = "in-flight";
		slot.cwd = cwd;
		slot.credentialScopeId = nextCredential;
		slot.toolContractFingerprint = toolContract.fingerprint;
		// Do not clear preSendConsumption here: baseline/checkpoint reads still run before agent.send.

		return {
			slot,
			live,
			continuing: false,
			customTools,
			prompt,
			incremental: plan.mode === "incremental",
		};
	} catch (error) {
		if (slots.get(slot.key) === slot) {
			// Failure here is before agent.send. A same-id resume may already have
			// superseded the committed journal handle; keep the verified consumption
			// so the retry imports that history and sends a continuation.
			const verifiedConsumption = identityMismatch
				? undefined
				: preservedSendState?.bootstrapped
					? preservedSendState
					: consumptionHandle?.sendState.bootstrapped
						? { ...consumptionHandle.sendState }
						: resumeHandle?.sendState.bootstrapped
							? { ...resumeHandle.sendState }
							: matchingPreSendConsumption(slot, cwd, nextCredential)
								?? (slot.sendState.bootstrapped ? { ...slot.sendState } : undefined);
			if (verifiedConsumption?.bootstrapped) {
				await disposeAgentKeepJournalConsumption(slot);
				stashPreSendConsumption(slot, verifiedConsumption, cwd, nextCredential);
			} else {
				clearPreSendConsumption(slot);
				await persistDirtyAndDisposeAgent(slot);
			}
		}
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
	slot.bindingState = "committed";
	clearPreSendConsumption(slot);
	const pending = resumePending(slot, "committed");
	if (pending) withCursorSessionOwner(slot.owner, () => persistResumeHandle(pending));
}

/** Record the assistant actually delivered, after commitTurn has snapshotted the inbound context. */
export function recordDeliveredAssistant(slot: RuntimeSlot, message: unknown): void {
	if (slots.get(slot.key) !== slot || slot.preparation?.signal.aborted) return;
	const digest = deliveredAssistantDigest(message);
	if (!digest) return;
	const live = getLiveRun(slot.key);
	if (live && !live.cancelled) live.deliveredAssistantDigest = digest;
	if (slot.bindingState !== "committed") return;
	slot.sendState = { ...slot.sendState, deliveredAssistantDigest: digest };
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
	slot.toolContractFingerprint = undefined;
	slot.store = undefined;
	clearPreSendConsumption(slot);
	slot.sendStarted = false;
}

export async function finishLiveKeepAgent(slot: RuntimeSlot, reason: string): Promise<void> {
	if (slots.get(slot.key) !== slot) return;
	await disposeLiveRun(slot.key, reason, false);
}

export async function finishTurnFailed(slot: RuntimeSlot, reason: string): Promise<void> {
	if (slots.get(slot.key) !== slot) return;
	// Prepare succeeded but agent.send never started: release the new agent, keep identity-checked consumption.
	if (!slot.sendStarted && slot.preSendConsumption) {
		slot.preparation?.abort();
		const proof = slot.preSendConsumption;
		const agent = slot.agent;
		slot.agent = undefined;
		slot.bindingState = "dirty";
		slot.createCwd = undefined;
		slot.credentialScopeId = undefined;
		slot.toolContractFingerprint = undefined;
		slot.store = undefined;
		slot.sendState = { ...proof.sendState };
		await disposeLiveRun(slot.key, reason, false);
		if (agent) await disposeAgent(agent);
		return;
	}
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
	rekeyRuntimeScope,
	/** Fake agents never own a real SDK executor, so prewarm becomes a no-op unless overridden. */
	setOpenAgent(fn: (input: OpenAgentInput) => Promise<SDKAgent>, prewarm: typeof prewarmLocalExecutor = async () => async () => undefined) {
		openAgentImpl = fn;
		prewarmImpl = prewarm;
	},
};
