import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { LocalAgentStore } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";
import { ConversationStateStructureSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { projectSourceHistoryUnits } from "../../src/context.ts";
import { nativeToolCallId } from "../../src/tool-call-id.ts";
import {
	ConversationSummaryArchiveSchema,
	decodeCheckpointSummaryState,
	decodeConversationSummaryArchive,
	resolveEffectiveSummaryCoverage,
} from "../../src/native-history.ts";

function conversation(count: number, start = 0): Context["messages"] {
	const messages: Context["messages"] = [];
	for (let index = start; index < start + count; index += 1) {
		messages.push({ role: "user", content: `u${index}`, timestamp: (index + 1) * 10 } as Context["messages"][number]);
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `a${index}` }],
			api: "cursor-sdk-agent",
			provider: "cursor-sdk",
			model: "composer-2.5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: (index + 1) * 10 + 1,
		} as Context["messages"][number]);
	}
	return messages;
}

function fixture() {
	const blobs = new Map<string, Uint8Array>();
	const put = (bytes: Uint8Array): Uint8Array => {
		const id = createHash("sha256").update(bytes).digest();
		blobs.set(id.toString("hex"), bytes);
		return id;
	};
	const modelMessage = (message: unknown) => put(new TextEncoder().encode(JSON.stringify(message)));
	const archive = (input: { messages: unknown[]; summary: string; windowTail: number; summaryMessage?: Uint8Array }) => {
		const summaryMessage = input.summaryMessage ?? modelMessage({ role: "user", content: [{ type: "text", text: `summary:${input.summary}` }] });
		const bytes = ConversationSummaryArchiveSchema.encode(ConversationSummaryArchiveSchema.create({
			summarizedMessages: input.messages.map(modelMessage),
			summary: input.summary,
			windowTail: input.windowTail,
			summaryMessage,
		}));
		return { reference: put(bytes), summaryMessage, bytes };
	};
	const state = (turns: number, archives: Uint8Array[]) => ConversationStateStructureSchema.encode(ConversationStateStructureSchema.create({
		turns: Array.from({ length: turns }, (_, index) => Uint8Array.of(index + 1)),
		turnsOld: [],
		summaryArchives: archives,
		summaryArchive: new Uint8Array(),
		selfSummaryCount: archives.length,
		summary: archives.length ? new TextEncoder().encode("private-state-summary") : new Uint8Array(),
	}));
	const store = {
		checkpoints: {
			async get(input: { blobId: string }) { return blobs.get(input.blobId) ?? null; },
		},
	} as unknown as LocalAgentStore;
	return { blobs, put, modelMessage, archive, state, store };
}

function archivedTurns(start: number, count: number): unknown[] {
	return Array.from({ length: count }, (_, offset) => {
		const index = start + offset;
		return [
			{ role: "user", content: [{ type: "text", text: `u${index}` }] },
			{ role: "assistant", content: [{ type: "text", text: `a${index}` }] },
		];
	}).flat();
}

describe("ConversationSummaryArchive", () => {
	test("loads content-addressed archive and message blobs before aligning complete interactions", async () => {
		const item = fixture();
		const archive = item.archive({
			messages: [{ role: "system", content: "native policy" }, ...archivedTurns(0, 5)],
			summary: "S1",
			windowTail: 2,
		});
		const decodedArchive = decodeConversationSummaryArchive(archive.bytes);
		expect(decodedArchive).toMatchObject({ summary: "S1", windowTail: 2 });
		expect(decodedArchive?.summaryMessage).toEqual(archive.summaryMessage);

		const after = await decodeCheckpointSummaryState(item.store, "agent-x", item.state(8, [archive.reference]));
		const messages = conversation(8);
		const coverage = resolveEffectiveSummaryCoverage(after!, projectSourceHistoryUnits(messages), messages);
		expect(coverage).toMatchObject({
			summary: "S1",
			summarizedTurnCount: 5,
			expandedSummarizedTurnCount: 5,
			windowTail: 2,
			includesPreviousSummary: false,
		});
		expect(coverage?.units.map((unit) => unit.kind)).toEqual(Array(5).fill("history-turn"));
	});

	test("expands a previous summary reference or consumes an existing OMP compaction summary", async () => {
		const item = fixture();
		const first = item.archive({ messages: archivedTurns(0, 5), summary: "S1", windowTail: 3 });
		const secondMessages = archivedTurns(5, 2);
		const secondBytes = ConversationSummaryArchiveSchema.encode(ConversationSummaryArchiveSchema.create({
			summarizedMessages: [first.summaryMessage, ...secondMessages.map(item.modelMessage)],
			summary: "S2",
			windowTail: 1,
			summaryMessage: item.modelMessage({ role: "user", content: [{ type: "text", text: "summary:S2" }] }),
		}));
		const second = item.put(secondBytes);
		const after = await decodeCheckpointSummaryState(item.store, "agent-x", item.state(8, [first.reference, second]));
		const original = conversation(8);
		const expanded = resolveEffectiveSummaryCoverage(after!, projectSourceHistoryUnits(original), original);
		expect(expanded).toMatchObject({ summarizedTurnCount: 7, includesPreviousSummary: true });

		const compacted: Context["messages"] = [
			{ role: "user", content: "S1", timestamp: 1000, historyRewriteAt: 1000 } as Context["messages"][number],
			...conversation(3, 5),
		];
		const materialized = resolveEffectiveSummaryCoverage(after!, projectSourceHistoryUnits(compacted), compacted);
		expect(materialized).toMatchObject({ summarizedTurnCount: 2, includesPreviousSummary: true });
		expect(materialized?.units[0]).toMatchObject({ kind: "previous-summary", summaryGeneration: 1 });
	});

	test("consumes a raw imported OMP compaction summary before aligning retained turns", async () => {
		const item = fixture();
		const archive = item.archive({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "native environment prefix" },
						{ type: "text", text: "S1" },
						{ type: "image", image: "data:image/png;base64,aW1hZ2U=", mimeType: "image/png" },
					],
				},
				{ role: "user", content: [{ type: "text", text: "u5" }] },
				{
					role: "assistant",
					content: [
						{ type: "redacted-reasoning", data: "opaque", providerOptions: { cursor: {} } },
						{ type: "text", text: "a5" },
					],
				},
				...archivedTurns(6, 1),
			],
			summary: "S2",
			windowTail: 1,
		});
		const after = await decodeCheckpointSummaryState(item.store, "agent-x", item.state(3, [archive.reference]));
		const retained = conversation(3, 5);
		retained[1] = {
			...retained[1],
			content: [
				{ type: "thinking", thinking: "visible but provider-private" },
				{ type: "text", text: "a5" },
			],
		} as Context["messages"][number];
		const compacted: Context["messages"] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "S1" },
					{ type: "image", data: "blob:sha256:source-image", mimeType: "image/png" },
				],
				timestamp: 1000,
				historyRewriteAt: 1000,
			} as Context["messages"][number],
			...retained,
		];
		expect(resolveEffectiveSummaryCoverage(after!, projectSourceHistoryUnits(compacted), compacted)).toMatchObject({
			summarizedTurnCount: 2,
			includesPreviousSummary: true,
		});

		const missingSummary = item.archive({ messages: archivedTurns(5, 2), summary: "unsafe", windowTail: 1 });
		const missingAfter = await decodeCheckpointSummaryState(item.store, "agent-x", item.state(3, [missingSummary.reference]));
		expect(resolveEffectiveSummaryCoverage(missingAfter!, projectSourceHistoryUnits(compacted), compacted)).toBeUndefined();
	});

	test("fails closed when a referenced archive or model message blob is absent", async () => {
		const item = fixture();
		const archive = item.archive({ messages: archivedTurns(0, 1), summary: "S", windowTail: 1 });
		item.blobs.delete(Buffer.from(archive.reference).toString("hex"));
		expect(await decodeCheckpointSummaryState(item.store, "agent-x", item.state(2, [archive.reference]))).toBeUndefined();

		const missingMessage = item.archive({ messages: archivedTurns(0, 1), summary: "S", windowTail: 1 });
		const decoded = decodeConversationSummaryArchive(missingMessage.bytes)!;
		item.blobs.delete(Buffer.from(decoded.summarizedMessages[0]!).toString("hex"));
		expect(await decodeCheckpointSummaryState(item.store, "agent-x", item.state(2, [missingMessage.reference]))).toBeUndefined();
	});

	test("does not drop an OMP prefix that was omitted from the native bootstrap", async () => {
		const item = fixture();
		const archive = item.archive({ messages: archivedTurns(1, 2), summary: "native suffix only", windowTail: 1 });
		const after = await decodeCheckpointSummaryState(item.store, "agent-x", item.state(3, [archive.reference]));
		const messages = conversation(4);
		expect(resolveEffectiveSummaryCoverage(after!, projectSourceHistoryUnits(messages), messages)).toBeUndefined();
	});

	test("does not cover a source interaction whose final assistant answer is missing from the archive", async () => {
		const item = fixture();
		const toolCallId = nativeToolCallId("call-1");
		const archive = item.archive({
			messages: [
				{ role: "user", content: [{ type: "text", text: "inspect" }] },
				{ role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: "read", input: { path: "a" } }] },
				{ role: "tool", id: toolCallId, content: [{ type: "tool-result", toolCallId, toolName: "read", result: "one" }] },
			],
			summary: "tools only",
			windowTail: 1,
		});
		const after = await decodeCheckpointSummaryState(item.store, "agent-x", item.state(2, [archive.reference]));
		const messages: Context["messages"] = [
			{ role: "user", content: "inspect", timestamp: 1 } as Context["messages"][number],
			{
				...conversation(1)[1],
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
				timestamp: 2,
			} as Context["messages"][number],
			{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "one" }], isError: false, timestamp: 3 } as Context["messages"][number],
			{ ...conversation(1)[1], content: [{ type: "text", text: "final" }], timestamp: 4 } as Context["messages"][number],
			...conversation(1, 2),
		];
		expect(resolveEffectiveSummaryCoverage(after!, projectSourceHistoryUnits(messages), messages)).toBeUndefined();
	});

	test("does not stitch omitted source text across later archive interaction boundaries", async () => {
		const item = fixture();
		const archive = item.archive({
			messages: [
				{ role: "user", content: [{ type: "text", text: "X" }] },
				{ role: "assistant", content: [{ type: "text", text: "Z" }] },
				{ role: "user", content: [{ type: "text", text: "W" }] },
				{ role: "assistant", content: [{ type: "text", text: "Y" }] },
			],
			summary: "later pair",
			windowTail: 1,
		});
		const after = await decodeCheckpointSummaryState(item.store, "agent-x", item.state(3, [archive.reference]));
		const messages: Context["messages"] = [
			{ role: "user", content: "X", timestamp: 1 } as Context["messages"][number],
			{ ...conversation(1)[1], content: [{ type: "text", text: "Y" }], timestamp: 2 } as Context["messages"][number],
			{ role: "user", content: "X", timestamp: 3 } as Context["messages"][number],
			{ ...conversation(1)[1], content: [{ type: "text", text: "Z" }], timestamp: 4 } as Context["messages"][number],
			{ role: "user", content: "W", timestamp: 5 } as Context["messages"][number],
			{ ...conversation(1)[1], content: [{ type: "text", text: "Y" }], timestamp: 6 } as Context["messages"][number],
			...conversation(1, 3),
		];
		expect(resolveEffectiveSummaryCoverage(after!, projectSourceHistoryUnits(messages), messages)).toBeUndefined();
	});

	test("rejects identical repeated source interactions without unique occurrence identity", async () => {
		const item = fixture();
		const archive = item.archive({
			messages: [
				{ role: "user", content: [{ type: "text", text: "same" }] },
				{ role: "assistant", content: [{ type: "text", text: "same answer" }] },
			],
			summary: "ambiguous",
			windowTail: 1,
		});
		const after = await decodeCheckpointSummaryState(item.store, "agent-x", item.state(3, [archive.reference]));
		const messages: Context["messages"] = [
			{ role: "user", content: "same", timestamp: 1 } as Context["messages"][number],
			{ ...conversation(1)[1], content: [{ type: "text", text: "same answer" }], timestamp: 2 } as Context["messages"][number],
			{ role: "user", content: "same", timestamp: 3 } as Context["messages"][number],
			{ ...conversation(1)[1], content: [{ type: "text", text: "same answer" }], timestamp: 4 } as Context["messages"][number],
			...conversation(1, 2),
		];
		expect(resolveEffectiveSummaryCoverage(after!, projectSourceHistoryUnits(messages), messages)).toBeUndefined();
	});
});
