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
	/** Stable resume identity: `session:<id>` or, with no id, `file:<path>`. */
	persistenceKey?: string;
	persistent: boolean;
	/** Exclusive journal writer for the current file (or file-less session id). */
	writer: boolean;
	generation: number;
}

const context = new AsyncLocalStorage<CursorSessionOwner>();
const owners = new Map<string, CursorSessionOwner>();
const managerOwners = new WeakMap<object, CursorSessionOwner>();
const writers = new Map<string, CursorSessionOwner>();
const leaseKeys = new WeakMap<CursorSessionOwner, string>();
const attachedOwners = new WeakSet<CursorSessionOwner>();
const requestOwner = new AsyncLocalStorage<{ owner?: CursorSessionOwner; generation?: number }>();
let defaultOwner = createOwner();
let onScopeRekey: (owner: CursorSessionOwner, fromScope: string, toScope: string) => void = () => {};

/** Runtime maps follow the owner when its scope key changes. Registered by session-runtime. */
export function setCursorScopeRekeyHandler(handler: (owner: CursorSessionOwner, fromScope: string, toScope: string) => void): void {
	onScopeRekey = handler;
}

function assignScopeKey(owner: CursorSessionOwner, nextScope: string): void {
	const previous = owner.scopeKey;
	if (previous !== nextScope) {
		if (owners.get(previous) === owner) owners.delete(previous);
		owner.scopeKey = nextScope;
		onScopeRekey(owner, previous, nextScope);
	}
	owners.set(owner.scopeKey, owner);
}

function createOwner(sessionId?: string, sessionFile?: string, cwd = process.cwd()): CursorSessionOwner {
	return {
		cwd,
		sessionId,
		sessionFile,
		scopeKey: sessionFile ?? `${EPHEMERAL_SESSION_SCOPE_PREFIX}${randomUUID()}`,
		persistent: false,
		writer: false,
		generation: 0,
	};
}

function persistenceKeyFor(sessionId?: string, sessionFile?: string): string | undefined {
	if (sessionId) return `session:${sessionId}`;
	if (sessionFile) return `file:${sessionFile}`;
	return undefined;
}

/** Writer exclusivity follows the file. File-less sessions lease the session id. */
function writerLease(sessionId?: string, sessionFile?: string): string | undefined {
	if (sessionFile) return `file:${sessionFile}`;
	if (sessionId) return `session:${sessionId}`;
	return undefined;
}

function writerScopeKey(sessionId?: string, sessionFile?: string): string {
	if (sessionFile) return sessionFile;
	if (sessionId) return `${EPHEMERAL_SESSION_SCOPE_PREFIX}${sessionId}`;
	return `${EPHEMERAL_SESSION_SCOPE_PREFIX}${randomUUID()}`;
}

function releaseWriter(owner: CursorSessionOwner): void {
	const lease = leaseKeys.get(owner);
	if (lease && writers.get(lease) === owner) writers.delete(lease);
	leaseKeys.delete(owner);
	if (owners.get(owner.scopeKey) === owner) owners.delete(owner.scopeKey);
	owner.writer = false;
	owner.persistent = false;
}

function holdLease(owner: CursorSessionOwner, lease: string | undefined): boolean {
	const current = leaseKeys.get(owner);
	if (current === lease) return true;
	const holder = lease ? writers.get(lease) : undefined;
	if (holder && holder !== owner) return false;
	if (current && writers.get(current) === owner) writers.delete(current);
	if (!lease) {
		leaseKeys.delete(owner);
		return true;
	}
	writers.set(lease, owner);
	leaseKeys.set(owner, lease);
	return true;
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
	const manager = ctx.sessionManager;
	let owner = managerOwners.get(manager);

	if (owner && owner.sessionId !== sessionId) {
		owner.generation += 1;
		releaseWriter(owner);
		managerOwners.delete(manager);
		owner = undefined;
	}

	if (owner && owner.writer && owner.sessionId === sessionId) {
		const lease = writerLease(sessionId, sessionFile);
		if (!holdLease(owner, lease)) releaseWriter(owner);
		owner.sessionFile = sessionFile;
		owner.cwd = ctx.cwd;
		owner.persistenceKey = persistenceKeyFor(sessionId, sessionFile);
		owner.persistent = owner.writer;
		// The file lease moved. Keep this live owner's runtime scope with the new file
		// so another manager of the old path cannot dispose it.
		if (owner.writer) assignScopeKey(owner, writerScopeKey(sessionId, sessionFile));
		return owner;
	}

	if (owner && !owner.writer) {
		const lease = writerLease(sessionId, sessionFile);
		const holder = lease ? writers.get(lease) : undefined;
		// An unattached lease holder is the authoritative writer. Rebind this manager to it.
		if (holder && holder !== owner && !attachedOwners.has(holder) && holder.sessionId === sessionId) {
			attachedOwners.add(holder);
			holder.sessionFile = sessionFile ?? holder.sessionFile;
			holder.cwd = ctx.cwd;
			holder.persistenceKey = persistenceKeyFor(sessionId, sessionFile);
			holder.persistent = holder.writer;
			managerOwners.set(manager, holder);
			return holder;
		}
		if (lease && !writers.has(lease)) {
			owner.writer = true;
			owner.persistent = true;
			owner.persistenceKey = persistenceKeyFor(sessionId, sessionFile);
			owner.sessionFile = sessionFile;
			owner.sessionId = sessionId;
			owner.cwd = ctx.cwd;
			owner.generation += 1;
			holdLease(owner, lease);
			assignScopeKey(owner, writerScopeKey(sessionId, sessionFile));
			return owner;
		}
		owner.sessionFile = sessionFile;
		owner.cwd = ctx.cwd;
		return owner;
	}

	const lease = writerLease(sessionId, sessionFile);
	const holder = lease ? writers.get(lease) : undefined;
	if (holder && !attachedOwners.has(holder) && holder.sessionId === sessionId) {
		attachedOwners.add(holder);
		holder.sessionFile = sessionFile ?? holder.sessionFile;
		holder.cwd = ctx.cwd;
		holder.persistenceKey = persistenceKeyFor(sessionId, sessionFile);
		holder.persistent = holder.writer;
		managerOwners.set(manager, holder);
		return holder;
	}

	const writer = !holder;
	const created = createOwner(sessionId, sessionFile, ctx.cwd);
	created.persistenceKey = persistenceKeyFor(sessionId, sessionFile);
	created.writer = writer;
	created.persistent = writer;
	created.scopeKey = writer ? writerScopeKey(sessionId, sessionFile) : `${EPHEMERAL_SESSION_SCOPE_PREFIX}${randomUUID()}`;
	if (writer) {
		holdLease(created, lease);
		owners.set(created.scopeKey, created);
	}
	attachedOwners.add(created);
	managerOwners.set(manager, created);
	return created;
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
		releaseWriter(owner);
		managerOwners.delete(ctx.sessionManager);
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
		defaultOwner.writer = true;
		defaultOwner.persistenceKey = persistenceKeyFor(sessionId, sessionFile);
		const lease = writerLease(sessionId, sessionFile);
		if (lease) {
			const holder = writers.get(lease);
			if (holder && holder !== defaultOwner) releaseWriter(holder);
			holdLease(defaultOwner, lease);
		}
		if (sessionFile || sessionId) owners.set(defaultOwner.scopeKey, defaultOwner);
	},
	reset() {
		owners.clear();
		writers.clear();
		defaultOwner = createOwner();
		defaultOwner.scopeKey = ANONYMOUS_SESSION_SCOPE_KEY;
	},
};
