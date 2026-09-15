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

export type StoreObservation =
	| {
		kind: "agents.write";
		op: "create" | "update";
		agent: {
			agentId: string;
			status: string;
			activeRunId?: string | null;
			latestCheckpoint?: { rootBlobId: string } | null;
		};
	}
	| { kind: "checkpoints.write"; op: "create" | "update"; agentId: string; blobId: string; bytes: number }
	| { kind: "runEvents.append"; runId: string; eventType: string; payload?: unknown };

/** Public LocalAgentStore proxy. Observer failures never fail the inner write. */
export function observeLocalAgentStore(store: LocalAgentStore, observer: (event: StoreObservation) => void): LocalAgentStore {
	const note = (event: StoreObservation) => {
		try { observer(event); } catch { /* observation must not break persistence */ }
	};
	return {
		agents: {
			get: (input) => store.agents.get(input),
			list: (input) => store.agents.list(input),
			delete: (input) => store.agents.delete(input),
			create: async (input) => {
				const agent = await store.agents.create(input);
				note({ kind: "agents.write", op: "create", agent });
				return agent;
			},
			update: async (input) => {
				const agent = await store.agents.update(input);
				note({ kind: "agents.write", op: "update", agent });
				return agent;
			},
		},
		checkpoints: {
			get: (input) => store.checkpoints.get(input),
			list: (input) => store.checkpoints.list(input),
			delete: (input) => store.checkpoints.delete(input),
			create: async (input) => {
				await store.checkpoints.create(input);
				note({
					kind: "checkpoints.write", op: "create",
					agentId: input.agentId, blobId: input.blobId, bytes: input.data.byteLength,
				});
			},
			update: async (input) => {
				await store.checkpoints.update(input);
				note({
					kind: "checkpoints.write", op: "update",
					agentId: input.agentId, blobId: input.blobId, bytes: input.data.byteLength,
				});
			},
		},
		runs: store.runs,
		runEvents: {
			list: (input) => store.runEvents.list(input),
			delete: (input) => store.runEvents.delete(input),
			append: async (input) => {
				const event = await store.runEvents.append(input);
				note({ kind: "runEvents.append", runId: input.runId, eventType: input.eventType, payload: input.payload });
				return event;
			},
		},
	};
}
