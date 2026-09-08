import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";
const EPHEMERAL_SESSION_SCOPE_PREFIX = "__ephemeral__:";

type ScopeChangeHandler = (previousScopeKey: string) => Promise<void> | void;

const state = {
	sessionCwd: process.cwd(),
	sessionFile: undefined as string | undefined,
	sessionId: undefined as string | undefined,
	sessionGeneration: 0,
};

const scopeGenerations = new Map<string, number>([[ANONYMOUS_SESSION_SCOPE_KEY, 0]]);
let nextSessionGeneration = 1;
let scopeChangeHandler: ScopeChangeHandler | undefined;

export function getCursorSessionFile(): string | undefined {
	return state.sessionFile;
}

export function getCursorSessionId(): string | undefined {
	return state.sessionId;
}

/** OMP session file when known; otherwise an ephemeral or anonymous key. */
export function getCursorSessionScopeKey(): string {
	if (state.sessionFile) return state.sessionFile;
	if (state.sessionId) return `${EPHEMERAL_SESSION_SCOPE_PREFIX}${state.sessionId}`;
	return ANONYMOUS_SESSION_SCOPE_KEY;
}

export function getCursorSessionScopeGeneration(scopeKey = getCursorSessionScopeKey()): number {
	return scopeGenerations.get(scopeKey) ?? 0;
}

export function getCursorSessionCwd(): string {
	return state.sessionCwd;
}

function setCursorSessionScope(cwd: string, sessionFile: string | undefined, sessionId?: string): void {
	state.sessionCwd = cwd;
	state.sessionFile = sessionFile;
	state.sessionId = sessionId;
	state.sessionGeneration = nextSessionGeneration;
	nextSessionGeneration += 1;
	scopeGenerations.set(getCursorSessionScopeKey(), state.sessionGeneration);
}

function resetCursorSessionScope(): void {
	state.sessionCwd = process.cwd();
	state.sessionFile = undefined;
	state.sessionId = undefined;
	state.sessionGeneration = 0;
	nextSessionGeneration = 1;
	scopeGenerations.clear();
	scopeGenerations.set(ANONYMOUS_SESSION_SCOPE_KEY, 0);
}

export function onCursorSessionScopeKeyChange(handler: ScopeChangeHandler): void {
	scopeChangeHandler = handler;
}

export function registerCursorSessionScope(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("session_start", async (_event, ctx) => {
		const previousScopeKey = getCursorSessionScopeKey();
		setCursorSessionScope(
			ctx.cwd,
			ctx.sessionManager?.getSessionFile?.() ?? undefined,
			ctx.sessionManager?.getSessionId?.() ?? undefined,
		);
		if (previousScopeKey !== getCursorSessionScopeKey()) {
			await scopeChangeHandler?.(previousScopeKey);
		}
	});
}

export const __testUtils = {
	ANONYMOUS_SESSION_SCOPE_KEY,
	EPHEMERAL_SESSION_SCOPE_PREFIX,
	set: setCursorSessionScope,
	reset: resetCursorSessionScope,
};
