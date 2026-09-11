import { expect, test } from "bun:test";
import type { LocalAgentDocument, LocalAgentStore } from "@cursor/sdk";
import { readSettledCheckpointOccupancy } from "../../src/native-history.ts";

// ConversationStateStructure field 5: usedTokens=150, maxTokens=100 (real overflow).
const occupancyBlob = new Uint8Array([42, 5, 8, 150, 1, 16, 100]);

function fixture() {
	let document: LocalAgentDocument | null = {
		agentId: "owned", cwd: "/project", status: "idle", createdAt: 1, updatedAt: 2,
		latestCheckpoint: { schemaVersion: 1, rootBlobId: "fresh" },
	};
	let blob: Uint8Array | null = occupancyBlob;
	const store = {
		agents: { get: async () => document },
		checkpoints: { get: async () => blob },
	} as unknown as LocalAgentStore;
	return { store, setDocument(value: LocalAgentDocument | null) { document = value; },
		setBlob(value: Uint8Array | null) { blob = value; }, get document() { return document!; } };
}

test("settled checkpoint reports genuine overflow rather than clamping or discarding it", async () => {
	const { store } = fixture();
	expect(await readSettledCheckpointOccupancy(store, "owned", "baseline")).toMatchObject({ usedTokens: 150, maxTokens: 100 });
});

test("unchanged imported or previous-turn roots cannot become current occupancy", async () => {
	const { store } = fixture();
	expect(await readSettledCheckpointOccupancy(store, "owned", "fresh")).toBeUndefined();
});

test("agent mismatch and a parked checkpoint cannot supply settled occupancy", async () => {
	const state = fixture();
	expect(await readSettledCheckpointOccupancy(state.store, "other", "baseline")).toBeUndefined();
	state.setDocument({ ...state.document, status: "running", activeRunId: "run" });
	expect(await readSettledCheckpointOccupancy(state.store, "owned", "baseline")).toBeUndefined();
});

test("a checkpoint replaced during its blob read is unavailable", async () => {
	const state = fixture();
	state.store.checkpoints.get = async () => {
		state.setDocument({ ...state.document, latestCheckpoint: { schemaVersion: 1, rootBlobId: "newer" } });
		return occupancyBlob;
	};
	expect(await readSettledCheckpointOccupancy(state.store, "owned", "baseline")).toBeUndefined();
});

test.each([
	["missing", null],
	["no token details", new Uint8Array()],
	["malformed", new Uint8Array([42, 3, 8])],
	["zero tokens", new Uint8Array([42, 2, 16, 100])],
	["zero maximum", new Uint8Array([42, 2, 8, 50])],
] as const)("%s checkpoint telemetry stays unavailable", async (_name, blob) => {
	const state = fixture();
	state.setBlob(blob);
	expect(await readSettledCheckpointOccupancy(state.store, "owned", "baseline")).toBeUndefined();
});

test("missing agent or root and optional store failures stay unavailable", async () => {
	const state = fixture();
	state.setDocument({ ...state.document, latestCheckpoint: null });
	expect(await readSettledCheckpointOccupancy(state.store, "owned", "baseline")).toBeUndefined();
	state.setDocument(null);
	expect(await readSettledCheckpointOccupancy(state.store, "owned", "baseline")).toBeUndefined();
	state.store.agents.get = async () => { throw new Error("disk unavailable"); };
	expect(await readSettledCheckpointOccupancy(state.store, "owned", "baseline")).toBeUndefined();
});
