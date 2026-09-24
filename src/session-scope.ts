import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";
const EPHEMERAL_SESSION_SCOPE_PREFIX = "__ephemeral__:";

export interface CursorSessionOwner {
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	scopeKey: string;
	persistent: boolean;
	generation: number;
}

const context = new AsyncLocalStorage<CursorSessionOwner>();
const owners = new Map<string, CursorSessionOwner>();
const anonymousOwners = new WeakMap<object, CursorSessionOwner>();
const requestOwner = new AsyncLocalStorage<{ owner?: CursorSessionOwner; generation?: number }>();
let defaultOwner = createOwner();

function createOwner(sessionId?: string, sessionFile?: string, cwd = process.cwd()): CursorSessionOwner {
	return { cwd, sessionId, sessionFile, scopeKey: sessionFile ?? `${EPHEMERAL_SESSION_SCOPE_PREFIX}${randomUUID()}`, persistent: false, generation: 0 };
}

export function getCursorSessionOwner(): CursorSessionOwner {
	return context.getStore() ?? defaultOwner;
}


export async function captureCursorRequestOwner<T>(run: () => T): Promise<{ owner?: CursorSessionOwner; generation?: number; value: Awaited<T> }> {
	const request: { owner?: CursorSessionOwner; generation?: number } = {};
	const value = await requestOwner.run(request, run);
	return { ...request, value };
}

export function withCursorSessionOwner<T>(owner: CursorSessionOwner, run: () => T): T {
	return context.run(owner, run);
}

/** Unbound requests never inherit a session just because its routing id matches. */
export function ownerForRequest(sessionId?: string, cwd?: string): CursorSessionOwner {
	return createOwner(sessionId, undefined, cwd);
}

export function ownerForContext(ctx: ExtensionContext): CursorSessionOwner {
	const sessionId = ctx.sessionManager.getSessionId?.();
	const sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
	const key = sessionFile ?? (sessionId ? `${EPHEMERAL_SESSION_SCOPE_PREFIX}${sessionId}` : undefined);
	let owner = key ? owners.get(key) : anonymousOwners.get(ctx.sessionManager);
	if (!owner || owner.sessionId !== sessionId) {
		owner = createOwner(sessionId, sessionFile, ctx.cwd);
		if (key) {
			owner.scopeKey = key;
			owners.set(key, owner);
		} else {
			anonymousOwners.set(ctx.sessionManager, owner);
		}
	}
	owner.cwd = ctx.cwd;
	owner.persistent = true;
	return owner;
}

/** Bind each callback from its actual host context, not the globally registered provider closure. */
export function sessionEvents(pi: Pick<ExtensionAPI, "on">): ExtensionAPI["on"] {
	return ((event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
		(pi.on as (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => void)(event, (event, ctx) =>
			withCursorSessionOwner(ownerForContext(ctx), () => handler(event, ctx)));
	}) as ExtensionAPI["on"];
}

export function getCursorSessionFile(): string | undefined {
	return getCursorSessionOwner().sessionFile;
}

export function getCursorSessionId(): string | undefined {
	return getCursorSessionOwner().sessionId;
}

export function getCursorSessionScopeKey(): string {
	return getCursorSessionOwner().scopeKey;
}

export function getCursorSessionCwd(): string {
	return getCursorSessionOwner().cwd;
}

export function registerCursorSessionScope(pi: Pick<ExtensionAPI, "on">): void {
	const on = sessionEvents(pi);
	on("before_provider_request", () => {
		const request = requestOwner.getStore();
		if (request) {
			request.owner = getCursorSessionOwner();
			request.generation = request.owner.generation;
		}
	});
	on("session_shutdown", (_event, ctx) => {
		const owner = getCursorSessionOwner();
		if (owners.get(owner.scopeKey) === owner) owners.delete(owner.scopeKey);
		anonymousOwners.delete(ctx.sessionManager);
	});
}

export const __testUtils = {
	ANONYMOUS_SESSION_SCOPE_KEY,
	EPHEMERAL_SESSION_SCOPE_PREFIX,
	bindRequest() {
		const request = requestOwner.getStore();
		if (!request) throw new Error("No Cursor SDK request is being bound");
		request.owner = getCursorSessionOwner();
		request.generation = request.owner.generation;
	},
	set(cwd: string, sessionFile: string | undefined, sessionId?: string) {
		defaultOwner = createOwner(sessionId, sessionFile, cwd);
		if (!sessionFile && sessionId) defaultOwner.scopeKey = `${EPHEMERAL_SESSION_SCOPE_PREFIX}${sessionId}`;
		defaultOwner.persistent = Boolean(sessionFile);
		if (sessionFile || sessionId) owners.set(defaultOwner.scopeKey, defaultOwner);
	},
	reset() {
		owners.clear();
		defaultOwner = createOwner();
		defaultOwner.scopeKey = ANONYMOUS_SESSION_SCOPE_KEY;
	},
};
