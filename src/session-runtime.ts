import { resolve as resolvePath } from "node:path";
import type { ModelSelection, SDKAgent, SDKCustomTool, SDKUserMessage } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { credentialScopeId } from "./auth.js";
import { DEFAULT_AGENT_INSTANCE_ID } from "./constants.js";
import type { BindingState, GrantedTool, OmpHostBridgeV1 } from "./contracts.js";
import { computeContextFingerprint, emptySendState, planSend, prepareSendInput, type ModelInputLimits, type SendState } from "./context.js";
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
import { openAgent, type OpenAgentInput } from "./sdk-session.js";
import { flushResumeHandleNow, getMatchingResumeHandle, persistResumeHandle, type ResumeStoreIdentity } from "./session-resume.js";
import { getCursorSessionCwd, getCursorSessionOwner, getCursorSessionScopeKey, withCursorSessionOwner, type CursorSessionOwner } from "./session-scope.js";
import { openScopedJsonlStore, storeRootForScope } from "./store.js";
import { buildCustomTools, newBridgeRunId } from "./tools.js";

export interface RuntimeSlot {
	key: string;
	owner: CursorSessionOwner;
	scopeKey: string;
	agentInstanceId: string;
	cwd: string;
	createCwd?: string;
	credentialScopeId?: string;
	includeWebSearch?: boolean;
	agent?: SDKAgent;
	sendState: SendState;
	bindingState: BindingState;
	storeIdentity: ResumeStoreIdentity;
	preparation?: AbortController;
}

const slots = new Map<string, RuntimeSlot>();
let openAgentImpl: (input: OpenAgentInput) => Promise<SDKAgent> = openAgent;

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
	if (existing) {
		existing.cwd = cwd;
		return existing;
	}
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
}

function attachParkExecutor(live: LiveRun, grantedTools: readonly GrantedTool[], host?: OmpHostBridgeV1): SharedToolExec {
	const exec = createSharedToolExec(grantedTools, (name, args, toolCallId) => {
		if (live.cancelled) throw new Error("Cursor SDK live run was cancelled");
		if (host) return host.executeTool(name, args, toolCallId);
		return parkToolCall(live, name, args, toolCallId);
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

async function persistDirtyAndDisposeAgent(slot: RuntimeSlot): Promise<void> {
	const dirty = resumePending(slot, "dirty");
	if (dirty) persistDirtyHandle(slot, dirty);
	const agent = slot.agent;
	slot.agent = undefined;
	slot.bindingState = "dirty";
	slot.createCwd = undefined;
	slot.credentialScopeId = undefined;
	slot.sendState = emptySendState();
	if (agent) await disposeAgent(agent);
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
		if (slotIdentityMismatch(slot, cwd, nextCredential) || Boolean(slot.includeWebSearch) !== Boolean(input.includeWebSearch)) {
			await finishTurnFailed(slot, "webSearch grant or identity changed during parked tool calls");
			throw new Error(
				slotIdentityMismatch(slot, cwd, nextCredential)
					? "Cannot continue parked Cursor SDK tool calls after cwd or credentials changed"
					: "Cannot continue parked Cursor SDK tool calls after webSearch grant changed",
			);
		}
		return { slot, live: existingLive, continuing: true, customTools: {}, incremental: true };
	}

	const modelSelection = input.modelSelection;
	if (!modelSelection) {
		throw new Error("Cannot open a Cursor SDK agent without a model selection");
	}

	const configMismatch = agentConfigMismatch(slot, cwd, nextCredential)
		|| Boolean(slot.agent) && Boolean(slot.includeWebSearch) !== Boolean(input.includeWebSearch);
	const unsafeBinding = Boolean(slot.agent) && (slot.bindingState !== "committed" || configMismatch);
	const resumeHandle = unsafeBinding ? undefined : getMatchingResumeHandle(input.agentInstanceId, nextCredential, cwd);
	const sendState = unsafeBinding ? emptySendState() : slot.agent ? slot.sendState : resumeHandle?.sendState ?? emptySendState();
	const plan = trailing.length > 0
		? { mode: "bootstrap" as const, resetAgent: true, reason: "context_divergence" as const }
		: planSend(sendState, input.context);
	const { prompt, history } = prepareSendInput(plan, input.context, input.modelLimits);

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
		if (existingLive || unsafeBinding) {
			await Promise.all([
				existingLive ? disposeLiveRun(slot.key, "OMP started a new user turn", false) : undefined,
				unsafeBinding ? persistDirtyAndDisposeAgent(slot) : undefined,
			]);
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
				await persistDirtyAndDisposeAgent(slot);
				assertCurrent();
			} else if (resumeHandle) {
				persistDirtyHandle(slot, resumeHandle);
				slot.bindingState = "dirty";
				slot.createCwd = undefined;
				slot.credentialScopeId = undefined;
				slot.sendState = emptySendState();
			}
		}

		const savedAgentId = slot.agent?.agentId ?? (slot.bindingState === "committed" ? resumeHandle?.agentId : undefined);
		const store = openScopedJsonlStore(cwd, scopeKey);
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
		const customTools = buildCustomTools(input.grantedTools, toolExec.execute, toolExec.dedupe, sdkToOmp);
		live.projection.sdkToOmp = sdkToOmp;

		if (!slot.agent) {
			const agent = await withSdkExitSuppressed(() =>
				openAgentImpl({
					apiKey: input.apiKey,
					cwd,
					model: modelSelection,
					store,
					customTools,
					includeWebSearch: input.includeWebSearch,
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
		}
		live.agent = slot.agent;
		live.checkpointStore = store;
		setLiveRun(slot.key, live);
		slot.bindingState = "in-flight";
		slot.cwd = cwd;
		slot.credentialScopeId = nextCredential;
		slot.includeWebSearch = Boolean(input.includeWebSearch);

		return {
			slot,
			live,
			continuing: false,
			customTools,
			prompt,
			incremental: plan.mode === "incremental",
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
}

export async function disposeRuntimeForShutdown(): Promise<void> {
	const pending = disposeRuntimeForScope();
	await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
}

export const __testUtils = {
	clear() {
		for (const slot of slots.values()) slot.preparation?.abort();
		slots.clear();
		openAgentImpl = openAgent;
	},
	slots,
	setOpenAgent(fn: (input: OpenAgentInput) => Promise<SDKAgent>) {
		openAgentImpl = fn;
	},
};
