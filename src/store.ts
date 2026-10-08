import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDefaultSdkStateRoot, JsonlLocalAgentStore, type LocalAgentStore } from "@cursor/sdk";

type StateRootFn = (cwd: string) => string;

let stateRootImpl: StateRootFn = getDefaultSdkStateRoot;
const rootChoices = new Map<string, string>();

export function storeRootForScope(cwd: string, scopeKey: string): string {
	const hash = createHash("sha256").update("omp-cursor-sdk-runtime\0").update(scopeKey).digest("hex").slice(0, 32);
	return join(stateRootImpl(cwd), "omp-cursor-runtime", hash);
}

function directoryPopulated(path: string): boolean {
	try {
		return existsSync(path) && readdirSync(path).length > 0;
	} catch {
		return false;
	}
}

/**
 * Prefer a populated journal directory when the recomputed SDK root is empty.
 * Covers an SDK workspace-root rename (MD5 to SHA-256) and a same-cwd scope move
 * without creating the empty computed directory first.
 */
export function resolveStoreRoot(cwd: string, scopeKey: string, journalRoot?: string): string {
	const computed = storeRootForScope(cwd, scopeKey);
	const cacheKey = `${computed}\0${journalRoot ?? ""}`;
	const cached = rootChoices.get(cacheKey);
	if (cached) return cached;
	const chosen = journalRoot && journalRoot !== computed && directoryPopulated(journalRoot) && !directoryPopulated(computed)
		? journalRoot
		: computed;
	rootChoices.set(cacheKey, chosen);
	return chosen;
}

export function openStoreAt(stateRoot: string): LocalAgentStore {
	return new JsonlLocalAgentStore(stateRoot);
}

export function openScopedJsonlStore(cwd: string, scopeKey: string): LocalAgentStore {
	return openStoreAt(storeRootForScope(cwd, scopeKey));
}

export const __testUtils = {
	setStateRoot(impl: StateRootFn) {
		stateRootImpl = impl;
		rootChoices.clear();
	},
	resetCache() {
		rootChoices.clear();
	},
	reset() {
		stateRootImpl = getDefaultSdkStateRoot;
		rootChoices.clear();
	},
};
