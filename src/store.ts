import { createHash } from "node:crypto";
import { join } from "node:path";
import { getDefaultSdkStateRoot, JsonlLocalAgentStore, type LocalAgentStore } from "@cursor/sdk";

export function storeRootForScope(cwd: string, scopeKey: string): string {
	const hash = createHash("sha256").update("omp-cursor-sdk-runtime\0").update(scopeKey).digest("hex").slice(0, 32);
	return join(getDefaultSdkStateRoot(cwd), "omp-cursor-runtime", hash);
}

export function openScopedJsonlStore(cwd: string, scopeKey: string): LocalAgentStore {
	return new JsonlLocalAgentStore(storeRootForScope(cwd, scopeKey));
}
