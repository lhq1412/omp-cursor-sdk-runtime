import { expect, test } from "bun:test";
import type { LocalAgentDocument, LocalAgentStore } from "@cursor/sdk";
import { ConversationStateStructureSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	createSummaryBoundaryProbe,
	readNativeCheckpoint,
	readSettledCheckpointOccupancy,
	reconcileSummaryBoundary,
} from "../../src/native-history.ts";
import { observeLocalAgentStore, type StoreObservation } from "../../src/store.ts";

function blob(partial: {
	turns?: number;
	turnsOld?: number;
	summaryArchives?: number;
	summaryArchive?: Uint8Array;
	selfSummaryCount?: number;
	summary?: Uint8Array;
	usedTokens?: number;
	maxTokens?: number;
}): Uint8Array {
	return ConversationStateStructureSchema.encode(ConversationStateStructureSchema.create({
		turns: Array.from({ length: partial.turns ?? 0 }, (_, i) => Uint8Array.of(i + 1)),
		turnsOld: Array.from({ length: partial.turnsOld ?? 0 }, (_, i) => Uint8Array.of(50 + i)),
		summaryArchives: Array.from({ length: partial.summaryArchives ?? 0 }, (_, i) => new Uint8Array(32).fill(90 + i)),
		summaryArchive: partial.summaryArchive ?? new Uint8Array(),
		selfSummaryCount: partial.selfSummaryCount ?? 0,
		summary: partial.summary ?? new Uint8Array(),
		...(partial.usedTokens !== undefined || partial.maxTokens !== undefined
			? { tokenDetails: { usedTokens: partial.usedTokens ?? 0, maxTokens: partial.maxTokens ?? 0 } }
			: {}),
	}));
}

function document(rootBlobId: string | null, extra: Partial<LocalAgentDocument> = {}): LocalAgentDocument {
	return {
		agentId: "owned",
		cwd: "/project",
		status: "idle",
		createdAt: 1,
		updatedAt: 2,
		latestCheckpoint: rootBlobId ? { schemaVersion: 1, rootBlobId } : null,
		...extra,
	};
}

function fake(root: string | null, blobs: Record<string, Uint8Array>) {
	let current = document(root);
	const store = {
		agents: {
			get: async () => current,
			create: async ({ agent }: { agent: LocalAgentDocument }) => { current = agent; return agent; },
			update: async ({ agent }: { agent: LocalAgentDocument }) => { current = agent; return agent; },
			delete: async () => undefined,
			list: async () => ({ items: [current] }),
		},
		checkpoints: {
			get: async ({ blobId }: { blobId: string }) => blobs[blobId] ?? null,
			create: async ({ blobId, data }: { blobId: string; data: Uint8Array }) => { blobs[blobId] = data; },
			update: async ({ blobId, data }: { blobId: string; data: Uint8Array }) => { blobs[blobId] = data; },
			delete: async () => undefined,
			list: async () => ({ items: Object.keys(blobs) }),
		},
		runs: {
			get: async () => null,
			create: async ({ run }: { run: unknown }) => run,
			update: async ({ run }: { run: unknown }) => run,
			delete: async () => undefined,
			list: async () => ({ items: [] }),
		},
		runEvents: {
			append: async (input: { runId: string; eventType: string; payload?: unknown }) => ({
				runId: input.runId, seq: 1, offset: "1", eventType: input.eventType,
				payload: input.payload, payloadRef: null, idempotencyKey: null, createdAt: 1,
			}),
			list: async () => ({ items: [] }),
			delete: async () => undefined,
		},
	} as unknown as LocalAgentStore;
	return {
		store,
		set(agent: LocalAgentDocument) { current = agent; },
		get agent() { return current; },
	};
}

test("checkpoint probe reports turn and archive counts without archive bytes", async () => {
	const summary = new TextEncoder().encode("user-summary-text");
	const archive = new Uint8Array(32).fill(9);
	const bytes = blob({
		turns: 15, turnsOld: 2, summaryArchives: 1, summaryArchive: archive,
		selfSummaryCount: 1, summary, usedTokens: 150, maxTokens: 100,
	});
	const { store } = fake("after", { after: bytes });
	const checkpoint = await readNativeCheckpoint(store, "owned");
	expect(checkpoint.tokenDetails).toEqual({ usedTokens: 150, maxTokens: 100 });
	expect(checkpoint.probe).toMatchObject({
		rootBlobId: "after",
		turns: 15,
		turnsOld: 2,
		summaryArchive: 1,
		summaryArchives: 1,
		selfSummaryCount: 1,
		summaryBytes: summary.byteLength,
		summaryArchiveBytes: 64,
		usedTokens: 150,
		maxTokens: 100,
	});
	expect(JSON.stringify(checkpoint.probe)).not.toContain("user-summary-text");
	expect(checkpoint.probe?.summaryHash).toMatch(/^[0-9a-f]{16}$/);
	expect(checkpoint.probe?.archivesHash).toMatch(/^[0-9a-f]{16}$/);
});

test("settled occupancy is unchanged when the blob also has summary counts", async () => {
	const { store } = fake("fresh", { fresh: blob({ turns: 45, selfSummaryCount: 0, usedTokens: 150, maxTokens: 100 }) });
	expect(await readSettledCheckpointOccupancy(store, "owned", "baseline")).toMatchObject({
		usedTokens: 150, maxTokens: 100, rootBlobId: "fresh",
	});
});

test("settle reconciliation discovers a new summary generation without delta events", async () => {
	const inner = fake("after", {
		before: blob({ turns: 12, selfSummaryCount: 0 }),
		after: blob({ turns: 13, summaryArchives: 1, selfSummaryCount: 1 }),
	});
	expect(await reconcileSummaryBoundary(inner.store, "owned", "before")).toMatchObject({
		summaryGeneration: 1,
		beforeRoot: "before",
		afterRoot: "after",
		before: { turns: 12, selfSummaryCount: 0 },
		after: { turns: 13, selfSummaryCount: 1 },
	});
});

test("store wrap forwards writes, omits blob bytes, and swallows observer throws", async () => {
	const inner = fake("old", { old: blob({ turns: 3 }) });
	const events: StoreObservation[] = [];
	const store = observeLocalAgentStore(inner.store, (event) => {
		events.push(event);
		throw new Error("probe bug");
	});
	const agent = document("new");
	const written = new Uint8Array([1, 2, 3, 4]);
	await expect(store.checkpoints.create({ agentId: "owned", blobId: "new", data: written })).resolves.toBeUndefined();
	await expect(store.agents.update({ agent })).resolves.toEqual(agent);
	await expect(store.runEvents.append({
		runId: "run-1", eventType: "preCompact", payload: { message_count: 45, messages_to_compact: 30 },
	})).resolves.toMatchObject({ eventType: "preCompact" });
	expect(events).toEqual([
		{ kind: "checkpoints.write", op: "create", agentId: "owned", blobId: "new", bytes: 4 },
		{ kind: "agents.write", op: "update", agent },
		{ kind: "runEvents.append", runId: "run-1", eventType: "preCompact", payload: { message_count: 45, messages_to_compact: 30 } },
	]);
	expect(JSON.stringify(events)).not.toContain("1,2,3,4");
});

test("completed summary plus idle new root yields a before/after probe", async () => {
	const beforeBytes = blob({ turns: 45, selfSummaryCount: 0, usedTokens: 80, maxTokens: 100 });
	const afterBytes = blob({ turns: 15, turnsOld: 0, summaryArchives: 1, selfSummaryCount: 1, usedTokens: 40, maxTokens: 100 });
	const inner = fake("before", { before: beforeBytes, after: afterBytes });
	const probe = createSummaryBoundaryProbe(inner.store);
	const store = observeLocalAgentStore(inner.store, (event) => {
		if (event.kind === "agents.write") probe.onAgentUpdated(event.agent);
		else if (event.kind === "runEvents.append") probe.onRunEvent(event);
	});
	probe.seed("before");
	await probe.onSummaryStarted("owned");
	await store.runEvents.append({
		runId: "run-1",
		eventType: "hook",
		payload: { preCompact: { message_count: 45, messages_to_compact: 30 } },
	});
	probe.onSummaryCompleted();
	inner.set(document("after", { status: "running", activeRunId: "run-1" }));
	await store.agents.update({ agent: inner.agent });
	expect(await probe.flush()).toBeUndefined();
	inner.set(document("after"));
	await store.agents.update({ agent: inner.agent });
	expect(await probe.flush()).toEqual({
		summaryGeneration: 1,
		beforeRoot: "before",
		afterRoot: "after",
		before: expect.objectContaining({ turns: 45, selfSummaryCount: 0 }),
		after: expect.objectContaining({ turns: 15, selfSummaryCount: 1, summaryArchives: 1 }),
		runEvent: { runId: "run-1", seq: 1, eventType: "hook", messageCount: 45, messagesToCompact: 30 },
	});
	expect(await probe.flush()).toBeUndefined();
});

test("summary without a new idle root does not invent a boundary", async () => {
	const inner = fake("same", { same: blob({ turns: 8 }) });
	const probe = createSummaryBoundaryProbe(inner.store);
	probe.seed("same");
	await probe.onSummaryStarted("owned");
	probe.onSummaryCompleted();
	probe.onAgentUpdated(inner.agent);
	expect(await probe.flush()).toBeUndefined();
});

test("a later summary cycle does not reuse a previous preCompact event", async () => {
	const firstAfter = blob({ turns: 15, summaryArchives: 1, selfSummaryCount: 1 });
	const secondAfter = blob({ turns: 8, summaryArchives: 2, selfSummaryCount: 2 });
	const inner = fake("before", {
		before: blob({ turns: 45, selfSummaryCount: 0 }),
		after: firstAfter,
		after2: secondAfter,
	});
	const probe = createSummaryBoundaryProbe(inner.store);
	const store = observeLocalAgentStore(inner.store, (event) => {
		if (event.kind === "agents.write") probe.onAgentUpdated(event.agent);
		else if (event.kind === "runEvents.append") probe.onRunEvent(event);
	});
	await store.runEvents.append({
		runId: "run-1",
		eventType: "preCompact",
		payload: { message_count: 45, messages_to_compact: 30 },
	});
	probe.seed("before");
	await probe.onSummaryStarted("owned");
	probe.onSummaryCompleted();
	inner.set(document("after"));
	await store.agents.update({ agent: inner.agent });
	expect((await probe.flush())?.runEvent).toEqual({
		runId: "run-1", seq: 1, eventType: "preCompact", messageCount: 45, messagesToCompact: 30,
	});

	probe.seed("after");
	await probe.onSummaryStarted("owned");
	probe.onSummaryCompleted();
	inner.set(document("after2"));
	await store.agents.update({ agent: inner.agent });
	const second = await probe.flush();
	expect(second).toMatchObject({ summaryGeneration: 2, afterRoot: "after2" });
	expect(second?.runEvent).toBeUndefined();
});

test("an abandoned cycle consumes its preCompact so the next generation cannot inherit it", async () => {
	const inner = fake("same", {
		same: blob({ turns: 8 }),
		next: blob({ turns: 4, summaryArchives: 1, selfSummaryCount: 1 }),
	});
	const probe = createSummaryBoundaryProbe(inner.store);
	const store = observeLocalAgentStore(inner.store, (event) => {
		if (event.kind === "agents.write") probe.onAgentUpdated(event.agent);
		else if (event.kind === "runEvents.append") probe.onRunEvent(event);
	});
	await store.runEvents.append({
		runId: "run-1",
		eventType: "preCompact",
		payload: { message_count: 45, messages_to_compact: 30 },
	});
	probe.seed("same");
	await probe.onSummaryStarted("owned");
	probe.onSummaryCompleted();
	probe.onAgentUpdated(inner.agent);
	expect(await probe.flush()).toBeUndefined();

	probe.seed("same");
	await probe.onSummaryStarted("owned");
	probe.onSummaryCompleted();
	inner.set(document("next"));
	await store.agents.update({ agent: inner.agent });
	const second = await probe.flush();
	expect(second).toMatchObject({ summaryGeneration: 2, afterRoot: "next" });
	expect(second?.runEvent).toBeUndefined();
});

test("flush waits for a fire-and-forget before checkpoint read", async () => {
	const gate = Promise.withResolvers<void>();
	const inner = fake("before", {
		before: blob({ turns: 45, selfSummaryCount: 0 }),
		after: blob({ turns: 15, summaryArchives: 1, selfSummaryCount: 1 }),
	});
	const originalGet = inner.store.checkpoints.get.bind(inner.store.checkpoints);
	inner.store.checkpoints.get = async (input) => {
		if (input.blobId === "before") await gate.promise;
		return originalGet(input);
	};
	const probe = createSummaryBoundaryProbe(inner.store);
	const store = observeLocalAgentStore(inner.store, (event) => {
		if (event.kind === "agents.write") probe.onAgentUpdated(event.agent);
	});
	probe.seed("before");
	void probe.onSummaryStarted("owned");
	probe.onSummaryCompleted();
	inner.set(document("after"));
	await store.agents.update({ agent: inner.agent });
	gate.resolve();
	expect(await probe.flush()).toMatchObject({
		beforeRoot: "before",
		afterRoot: "after",
		before: { turns: 45, selfSummaryCount: 0 },
		after: { turns: 15, selfSummaryCount: 1 },
	});
});

