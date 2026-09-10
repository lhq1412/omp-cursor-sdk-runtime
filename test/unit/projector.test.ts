import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { applyInteractionUpdate, applyToolCall, createEmptyAssistantMessage, projectRunUsage, reconcileRunResult, type RunProjection } from "../../src/projector.ts";
import type { RunResult, TokenUsage } from "@cursor/sdk";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import type { Model } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";

describe("projector", () => {
	test("accumulates text deltas without duplicating blocks", () => {
		const model = {
			id: "composer-2.5",
			provider: CURSOR_SDK_PROVIDER_ID,
			api: CURSOR_SDK_API,
		} as Model<Api>;
		const stream = createAssistantMessageEventStream();
		const partial = createEmptyAssistantMessage(model);
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "Hel" });
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "lo" });
		expect(partial.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	test("emits a closed toolCall block for OMP toolUse", () => {
		const model = {
			id: "composer-2.5",
			provider: CURSOR_SDK_PROVIDER_ID,
			api: CURSOR_SDK_API,
		} as Model<Api>;
		const stream = createAssistantMessageEventStream();
		const partial = createEmptyAssistantMessage(model);
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "Using read" });
		applyToolCall(stream, partial, { id: "call-1", name: "read", arguments: { path: "a.ts" } });
		expect(partial.content[1]).toMatchObject({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } });
	});

	test("reconciles the final answer step rather than earlier commentary", () => {
		const stream = createAssistantMessageEventStream();
		const partial = createEmptyAssistantMessage({ id: "composer-2.5" } as Model<Api>);
		const projection: RunProjection = { answerText: "" };
		applyInteractionUpdate(stream, partial, { type: "step-started", stepId: 1 }, projection);
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "I'll inspect it." }, projection);
		applyToolCall(stream, partial, { id: "read-1", name: "read", arguments: {} });
		applyInteractionUpdate(stream, partial, { type: "step-started", stepId: 2 }, projection);
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "The ans" }, projection);
		const result = { id: "run-1", status: "finished", result: "The answer is 42." } as RunResult;
		reconcileRunResult(stream, partial, projection, result);
		reconcileRunResult(stream, partial, projection, result);
		expect(partial.content).toEqual([
			{ type: "text", text: "I'll inspect it." },
			{ type: "toolCall", id: "read-1", name: "read", arguments: {} },
			{ type: "text", text: "The answer is 42." },
		]);
	});

	test("delivers final-only text and does not repeat a complete streamed answer", () => {
		const stream = createAssistantMessageEventStream();
		for (const streamed of ["", "Complete answer"]) {
			const partial = createEmptyAssistantMessage({ id: "composer-2.5" } as Model<Api>);
			const projection: RunProjection = { answerText: "" };
			applyInteractionUpdate(stream, partial, { type: "text-delta", text: streamed }, projection);
			reconcileRunResult(stream, partial, projection, { id: "run", status: "finished", result: "Complete answer" });
			expect(partial.content).toEqual([{ type: "text", text: "Complete answer" }]);
		}
	});

	test("corrects a non-prefix final answer without duplicating earlier steps", () => {
		const stream = createAssistantMessageEventStream();
		for (const streamed of ["answer is 42.", "The answer 42."]) {
			const partial = createEmptyAssistantMessage({ id: "composer-2.5" } as Model<Api>);
			const projection: RunProjection = { answerText: "" };
			applyInteractionUpdate(stream, partial, { type: "text-delta", text: "I'll inspect it." }, projection);
			applyToolCall(stream, partial, { id: "read-1", name: "read", arguments: {} });
			applyInteractionUpdate(stream, partial, { type: "step-started", stepId: 2 }, projection);
			applyInteractionUpdate(stream, partial, { type: "text-delta", text: streamed }, projection);
			reconcileRunResult(stream, partial, projection, { id: "run", status: "finished", result: "The answer is 42." });
			expect(partial.content).toEqual([
				{ type: "text", text: "I'll inspect it." },
				{ type: "toolCall", id: "read-1", name: "read", arguments: {} },
				{ type: "text", text: "The answer is 42." },
			]);
		}
	});

	test("keeps prior-step text when a later answer is corrected without a toolCall separator", () => {
		const stream = createAssistantMessageEventStream();
		const partial = createEmptyAssistantMessage({ id: "composer-2.5" } as Model<Api>);
		const projection: RunProjection = { answerText: "" };
		applyInteractionUpdate(stream, partial, { type: "step-started", stepId: 1 }, projection);
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "Earlier commentary.\n" }, projection);
		applyInteractionUpdate(stream, partial, { type: "step-started", stepId: 2 }, projection);
		applyInteractionUpdate(stream, partial, { type: "step-started", stepId: 3 }, projection);
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "answer is 42." }, projection);
		reconcileRunResult(stream, partial, projection, { id: "run", status: "finished", result: "The answer is 42." });
		expect(partial.content).toEqual([
			{ type: "text", text: "Earlier commentary.\n" },
			{ type: "text", text: "The answer is 42." },
		]);
	});

	test("accounts cumulative usage once across parked messages and keeps unknowns honest", () => {
		const model = { id: "composer-2.5" } as Model<Api>;
		const projection: RunProjection = { answerText: "" };
		const first = createEmptyAssistantMessage(model);
		const usage: TokenUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10, totalTokens: 170, reasoningTokens: 5 };
		projectRunUsage(first, projection, usage);
		const second = createEmptyAssistantMessage(model);
		projectRunUsage(second, projection, usage);
		projectRunUsage(second, projection, { ...usage, inputTokens: 140, outputTokens: 30, totalTokens: 220, reasoningTokens: 8 });
		expect(first.usage).toMatchObject({ input: 100, output: 20, cacheRead: 40, cacheWrite: 10, totalTokens: 170 });
		expect(second.usage).toMatchObject({ input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50, reasoningTokens: 3 });
		expect(second.usage.contextTokens).toBeUndefined();
		expect(second.cursorSdk).toEqual({ tokenUsage: "actual", cost: "unavailable", contextOccupancy: { status: "unavailable" } });
		const nextRun = createEmptyAssistantMessage(model);
		projectRunUsage(nextRun, { answerText: "" }, usage);
		expect(nextRun.usage.totalTokens).toBe(170);
		const unavailable = createEmptyAssistantMessage(model);
		projectRunUsage(unavailable, { answerText: "" }, undefined);
		expect(unavailable.cursorSdk.tokenUsage).toBe("unavailable");
	});

	test("keeps cumulative turn aggregates as deduplicated billing, not context occupancy", () => {
		const stream = createAssistantMessageEventStream();
		const model = { id: "composer-2.5" } as Model<Api>;
		const partial = createEmptyAssistantMessage(model);
		const projection: RunProjection = { answerText: "" };
		const usage: TokenUsage = {
			inputTokens: 1_180_000, outputTokens: 20_000,
			cacheReadTokens: 5_040_000, cacheWriteTokens: 1_560_000,
			totalTokens: 7_800_000, reasoningTokens: 5_000,
		};
		projectRunUsage(partial, projection, usage);
		applyInteractionUpdate(stream, partial, { type: "turn-ended", usage }, projection);
		const result: RunResult = { id: "run", status: "finished", usage };
		projectRunUsage(partial, projection, result.usage);
		expect(partial.usage).toMatchObject({
			input: 1_180_000, output: 20_000, cacheRead: 5_040_000, cacheWrite: 1_560_000,
			totalTokens: 7_800_000, reasoningTokens: 5_000,
		});
		expect(partial.cursorSdk.tokenUsage).toBe("actual");
		expect(partial.cursorSdk.contextOccupancy).toEqual({ status: "unavailable" });
		expect(partial.usage.contextTokens).toBeUndefined();

		const resumed = createEmptyAssistantMessage(model);
		projectRunUsage(resumed, projection, {
			inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10,
			totalTokens: 170, reasoningTokens: 5,
		});
		projectRunUsage(resumed, projection, result.usage);
		expect(resumed.usage).toMatchObject({
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0,
		});
		expect(resumed.cursorSdk.tokenUsage).toBe("actual");
		expect(resumed.cursorSdk.contextOccupancy).toEqual({ status: "unavailable" });
		expect(resumed.usage.contextTokens).toBeUndefined();
	});
});
