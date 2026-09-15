import { describe, expect, test } from "bun:test";
import { ConversationStateStructureSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import type { Context } from "@oh-my-pi/pi-ai";
import { projectSourceHistoryUnits } from "../../src/context.ts";
import {
	ConversationSummaryArchiveSchema,
	decodeCheckpointSummaryState,
	decodeConversationSummaryArchive,
	resolveEffectiveSummaryCoverage,
	validateNativeTurnAlignment,
} from "../../src/native-history.ts";

function turnBytes(id: number): Uint8Array {
	return Uint8Array.of(id);
}

function archive(input: {
	summarized: Uint8Array[];
	summary: string;
	windowTail: number;
	summaryMessage: Uint8Array;
}): Uint8Array {
	return ConversationSummaryArchiveSchema.encode(ConversationSummaryArchiveSchema.create({
		summarizedMessages: input.summarized,
		summary: input.summary,
		windowTail: input.windowTail,
		summaryMessage: input.summaryMessage,
	}));
}

function state(turns: number, archives: Uint8Array[], extra: { usedTokens?: number; summary?: Uint8Array } = {}): Uint8Array {
	return ConversationStateStructureSchema.encode(ConversationStateStructureSchema.create({
		turns: Array.from({ length: turns }, (_, index) => turnBytes(index + 1)),
		turnsOld: [],
		summaryArchives: archives,
		summaryArchive: new Uint8Array(),
		selfSummaryCount: archives.length,
		summary: extra.summary ?? (archives.length ? new TextEncoder().encode("state-summary") : new Uint8Array()),
		...(extra.usedTokens !== undefined ? { tokenDetails: { usedTokens: extra.usedTokens, maxTokens: 100 } } : {}),
	}));
}

function conversation(count: number): Context["messages"] {
	const messages: Context["messages"] = [];
	for (let index = 0; index < count; index += 1) {
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

describe("ConversationSummaryArchive", () => {
	test("round-trips summarized_messages, summary, window_tail, and summary_message", () => {
		const summaryMessage = new TextEncoder().encode("summary-envelope");
		const encoded = archive({
			summarized: [turnBytes(1), turnBytes(2)],
			summary: "S(A..B)",
			windowTail: 3,
			summaryMessage,
		});
		const decoded = decodeConversationSummaryArchive(encoded);
		expect(decoded).toMatchObject({ summary: "S(A..B)", windowTail: 3 });
		expect(decoded?.summarizedMessages).toHaveLength(2);
		expect(decoded?.summaryMessage).toEqual(summaryMessage);
		expect(decoded?.archiveHash).toHaveLength(16);
		expect(decoded?.summaryMessageHash).toHaveLength(16);
	});

	test("maps a single summary by turn count: expanded + windowTail === source turns", () => {
		const summaryMessage = new TextEncoder().encode("s1");
		const after = decodeCheckpointSummaryState(state(3, [archive({
			summarized: [turnBytes(1), turnBytes(2), turnBytes(3), turnBytes(4), turnBytes(5)],
			summary: "S1",
			windowTail: 3,
			summaryMessage,
		})], { usedTokens: 40, summary: new TextEncoder().encode("S1") }));
		const before = decodeCheckpointSummaryState(state(8, [], { usedTokens: 80 }));
		const sourceUnits = projectSourceHistoryUnits(conversation(8));
		const coverage = resolveEffectiveSummaryCoverage(before, after!, sourceUnits);
		expect(coverage).toMatchObject({
			summary: "S1",
			summarizedTurnCount: 5,
			windowTail: 3,
			includesPreviousSummary: false,
			expandedSummarizedTurnCount: 5,
		});
		expect(coverage?.units.filter((unit) => unit.kind === "history-turn").map((unit) => unit.sourceUnitOrdinal)).toEqual([0, 1, 2, 3, 4]);
		expect(validateNativeTurnAlignment(coverage!, sourceUnits, after!.turns, before!.turns)).toBe(true);
	});

	test("expands a second archive through previous summary_message identity", () => {
		const s1Message = new TextEncoder().encode("s1-envelope");
		const archive1 = archive({
			summarized: [turnBytes(1), turnBytes(2), turnBytes(3), turnBytes(4), turnBytes(5)],
			summary: "S1",
			windowTail: 3,
			summaryMessage: s1Message,
		});
		const archive2 = archive({
			summarized: [s1Message, turnBytes(6), turnBytes(7)],
			summary: "S2",
			windowTail: 1,
			summaryMessage: new TextEncoder().encode("s2-envelope"),
		});
		const after = decodeCheckpointSummaryState(state(1, [archive1, archive2]));
		const sourceUnits = projectSourceHistoryUnits(conversation(8));
		const coverage = resolveEffectiveSummaryCoverage(undefined, after!, sourceUnits);
		expect(coverage).toMatchObject({
			summary: "S2",
			summarizedTurnCount: 2,
			windowTail: 1,
			includesPreviousSummary: true,
			expandedSummarizedTurnCount: 7,
		});
		expect(coverage?.units[0]).toMatchObject({ kind: "previous-summary", summaryGeneration: 1 });
		expect(validateNativeTurnAlignment(coverage!, sourceUnits, after!.turns)).toBe(true);
	});

	test("marks turn-count mismatch as inapplicable", () => {
		const after = decodeCheckpointSummaryState(state(3, [archive({
			summarized: [turnBytes(1)],
			summary: "S",
			windowTail: 3,
			summaryMessage: new TextEncoder().encode("s"),
		})]));
		const sourceUnits = projectSourceHistoryUnits(conversation(8));
		const coverage = resolveEffectiveSummaryCoverage(undefined, after!, sourceUnits);
		expect(coverage).toBeDefined();
		expect(validateNativeTurnAlignment(coverage!, sourceUnits, after!.turns, 8)).toBe(false);
	});

	test("does not treat a later archive as covering the previous summary without byte identity", () => {
		const archive1 = archive({
			summarized: [turnBytes(1)],
			summary: "S1",
			windowTail: 2,
			summaryMessage: new TextEncoder().encode("s1-envelope"),
		});
		const archive2 = archive({
			summarized: [new TextEncoder().encode("not-s1"), turnBytes(2)],
			summary: "S2",
			windowTail: 1,
			summaryMessage: new TextEncoder().encode("s2-envelope"),
		});
		const after = decodeCheckpointSummaryState(state(1, [archive1, archive2]));
		const sourceUnits = projectSourceHistoryUnits(conversation(3));
		const coverage = resolveEffectiveSummaryCoverage(undefined, after!, sourceUnits);
		expect(coverage?.includesPreviousSummary).toBe(false);
	});
});
