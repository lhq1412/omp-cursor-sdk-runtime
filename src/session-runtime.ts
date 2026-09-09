import { resolve as resolvePath } from "node:path";
import type { SDKAgent, SDKCustomTool, SDKUserMessage } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { credentialScopeId } from "./auth.js";
import { DEFAULT_AGENT_INSTANCE_ID } from "./constants.js";
import type { BindingState, GrantedTool, OmpHostBridgeV1 } from "./contracts.js";
import { computeContextFingerprint, emptySendState, planSend, turnPrompt, type SendState } from "./context.js";
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
import { defaultModelSelection, openAgent, type OpenAgentInput } from "./sdk-session.js";
import { flushResumeHandleNow, getMatchingResumeHandle, persistResumeHandle, type ResumeStoreIdentity } from "./session-resume.js";
import { getCursorSessionCwd, getCursorSessionScopeKey } from "./session-scope.js";
import { openScopedJsonlStore, storeRootForScope } from "./store.js";
import { buildCustomTools, newBridgeRunId } from "./tools.js";

export interface RuntimeSlot {
	key: string;
	scopeKey: string;
	agentInstanceId: string;
	cwd: string;
	createCwd?: string;
	credentialScopeId?: string;
	agent?: SDKAgent;
	sendState: SendState;
	bindingState: BindingState;
	storeIdentity: ResumeStoreIdentity;
}

const slots = new Map<string, RuntimeSlot>();
let openAgentImpl: (input: OpenAgentInput) => Promise<SDKAgent> = openAgent;

export function runtimeKey(scopeKey = getCursorSessionScopeKey(), agentInstanceId = DEFAULT_AGENT_INSTANCE_ID): string {
	return liveRunKey(scopeKey, agentInstanceId);
}

export function getRuntimeSlot(key: string): RuntimeSlot | undefined {
	return slots.get(key);
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
	modelId: string;
	context: Context;
	grantedTools: readonly GrantedTool[];
	host?: OmpHostBridgeV1;
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
		flushResumeHandleNow(dirty);
	} catch {
		persistResumeHandle(dirty);
	}
}

async function persistDirtyAndDisposeAgent(slot: RuntimeSlot): Promise<void> {
	const dirty = resumePending(slot, "dirty");
	if (dirty) persistDirtyHandle(slot, dirty);
	if (slot.agent) {
		await disposeAgent(slot.agent);
		slot.agent = undefined;
	}
	slot.bindingState = "dirty";
	slot.createCwd = undefined;
	slot.credentialScopeId = undefined;
	slot.sendState = emptySendState();
}

function invalidateBindingBeforeSend(slot: RuntimeSlot, agentId: string): void {
	if (!slot.createCwd) {
		throw new Error("Cannot invalidate a Cursor SDK binding without the agent's execution cwd");
	}
	flushResumeHandleNow({
		agentId,
		poolKey: slot.agentInstanceId,
		sendState: { ...slot.sendState },
		storeIdentity: slot.storeIdentity,
		state: "in-flight",
		agentInstanceId: slot.agentInstanceId,
		cwd: slot.createCwd,
		...(slot.credentialScopeId ? { credentialScopeId: slot.credentialScopeId } : {}),
	});
	slot.bindingState = "in-flight";
}

export async function prepareTurn(input: OpenRuntimeTurnInput): Promise<PreparedTurn> {
	const scopeKey = getCursorSessionScopeKey();
	const cwd = normalizeRuntimeCwd(input.cwd || getCursorSessionCwd());
	const nextCredential = credentialScopeId(input.apiKey);
	const slot = getOrCreateSlot(scopeKey, input.agentInstanceId, cwd);
	const existingLive = getLiveRun(slot.key);
	const trailing = trailingToolResults(input.context);
	const continuing = Boolean(existingLive && trailing.length > 0);

	if (trailing.length > 0 && !existingLive) {
		throw new Error("Cannot continue parked Cursor SDK tool calls after the adapter restarted; send a new user turn");
	}

	if (existingLive && continuing) {
		if (slotIdentityMismatch(slot, cwd, nextCredential)) {
			await finishTurnFailed(slot, "identity changed during parked tool calls");
			throw new Error("Cannot continue parked Cursor SDK tool calls after cwd or credentials changed");
		}
		return { slot, live: existingLive, continuing: true, customTools: {}, incremental: true };
	}

	if (existingLive) {
		await disposeLiveRun(slot.key, "OMP started a new user turn", false);
	}

	const configMismatch = agentConfigMismatch(slot, cwd, nextCredential);
	const unsafeBinding = Boolean(slot.agent) && (slot.bindingState !== "committed" || configMismatch);
	if (unsafeBinding) {
		await persistDirtyAndDisposeAgent(slot);
	}

	const resumeHandle = getMatchingResumeHandle(input.agentInstanceId, nextCredential, cwd);
	if (resumeHandle && !slot.agent) {
		slot.sendState = { ...resumeHandle.sendState };
		slot.bindingState = "committed";
		slot.createCwd = resumeHandle.cwd;
		slot.credentialScopeId = resumeHandle.credentialScopeId;
		slot.storeIdentity = resumeHandle.storeIdentity ?? slot.storeIdentity;
	} else if (!slot.agent) {
		slot.sendState = emptySendState();
	}

	let plan = planSend(slot.sendState, input.context);
	if (plan.resetAgent) {
		if (slot.agent) {
			await persistDirtyAndDisposeAgent(slot);
		} else if (resumeHandle) {
			persistDirtyHandle(slot, resumeHandle);
			slot.bindingState = "dirty";
			slot.createCwd = undefined;
			slot.credentialScopeId = undefined;
			slot.sendState = emptySendState();
		}
		plan = planSend(slot.sendState, input.context);
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
	const customTools = buildCustomTools(input.grantedTools, toolExec.execute, toolExec.dedupe);

	if (!slot.agent) {
		slot.agent = await withSdkExitSuppressed(() =>
			openAgentImpl({
				apiKey: input.apiKey,
				cwd,
				model: defaultModelSelection(input.modelId),
				store,
				customTools,
				savedAgentId,
			}),
		);
		slot.createCwd = cwd;
		slot.credentialScopeId = nextCredential;
	}
	live.agent = slot.agent;
	setLiveRun(slot.key, live);
	slot.bindingState = "in-flight";
	slot.cwd = cwd;
	slot.credentialScopeId = nextCredential;

	return {
		slot,
		live,
		continuing: false,
		customTools,
		prompt: turnPrompt(plan, input.context),
		incremental: plan.mode === "incremental",
	};
}

export function commitTurn(slot: RuntimeSlot, context: Context, incremental: boolean): void {
	slot.sendState = {
		bootstrapped: true,
		contextFingerprint: computeContextFingerprint(context),
		incrementalSendCount: incremental ? slot.sendState.incrementalSendCount + 1 : 0,
	};
	slot.bindingState = "committed";
	if (!slot.agent || !slot.createCwd) return;
	persistResumeHandle({
		agentId: slot.agent.agentId,
		poolKey: slot.agentInstanceId,
		sendState: { ...slot.sendState },
		storeIdentity: slot.storeIdentity,
		state: "committed",
		agentInstanceId: slot.agentInstanceId,
		cwd: slot.createCwd,
		...(slot.credentialScopeId ? { credentialScopeId: slot.credentialScopeId } : {}),
	});
}

export function markTurnDirty(slot: RuntimeSlot): void {
	slot.bindingState = "dirty";
	const dirty = resumePending(slot, "dirty");
	if (dirty) {
		try {
			flushResumeHandleNow(dirty);
		} catch {
			persistResumeHandle(dirty);
		}
	}
	slot.agent = undefined;
	slot.sendState = emptySendState();
}

export async function finishLiveKeepAgent(key: string, reason: string): Promise<void> {
	await disposeLiveRun(key, reason, false);
}

export async function finishTurnFailed(slot: RuntimeSlot, reason: string): Promise<void> {
	markTurnDirty(slot);
	await disposeLiveRun(slot.key, reason, true);
}

export function invalidateRuntime(_reason: string): void {
	for (const slot of slots.values()) {
		const agent = slot.agent;
		markTurnDirty(slot);
		slot.sendState = emptySendState();
		if (agent) void disposeAgent(agent);
	}
	for (const key of slots.keys()) {
		void disposeLiveRun(key, "runtime invalidated", false);
	}
}

export async function disposeRuntimeForScope(scopeKey = getCursorSessionScopeKey()): Promise<void> {
	for (const [key, slot] of [...slots.entries()]) {
		if (slot.scopeKey !== scopeKey) continue;
		await disposeLiveRun(key, "session scope closed", false);
		if (slot.agent) await disposeAgent(slot.agent);
		slots.delete(key);
	}
}

export async function disposeRuntimeForShutdown(): Promise<void> {
	const pending = Promise.all([...new Set([...slots.values()].map((slot) => slot.scopeKey))].map((scopeKey) => disposeRuntimeForScope(scopeKey)));
	await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
}

export const __testUtils = {
	clear() {
		slots.clear();
		openAgentImpl = openAgent;
	},
	slots,
	setOpenAgent(fn: (input: OpenAgentInput) => Promise<SDKAgent>) {
		openAgentImpl = fn;
	},
};
