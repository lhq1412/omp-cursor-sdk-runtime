import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolArgStream } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { applyInteractionUpdate, applyToolCall, createEmptyAssistantMessage, dropUnendedPreviews, projectRunUsage, reconcileRunResult, type RunProjection } from "../../src/projector.ts";
import type { InteractionUpdate, RunResult, TokenUsage } from "@cursor/sdk";
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

	test("streams JSON arguments matching the completed tool call", async () => {
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
		stream.end(partial);
		let argumentsJson = "";
		for await (const event of stream) {
			if (event.type === "toolcall_delta") {
				expect(event.partial.content[event.contentIndex]).toEqual(partial.content[1]);
				argumentsJson += event.delta;
			} else if (event.type === "toolcall_end") {
				expect(JSON.parse(argumentsJson)).toEqual(event.toolCall.arguments);
			}
		}
	});

	function mcpUpdate(
		type: "tool-call-started" | "partial-tool-call",
		callId: string,
		toolName: string,
		args: Record<string, unknown>,
	): InteractionUpdate {
		return {
			type,
			callId,
			modelCallId: "model-1",
			toolCall: { type: "mcp", args: { toolName, providerIdentifier: "custom-user-tools", args } },
		} as InteractionUpdate;
	}

	test("previews correlatable MCP snapshots and closes them without a second call", async () => {
		const model = {
			id: "composer-2.5",
			provider: CURSOR_SDK_PROVIDER_ID,
			api: CURSOR_SDK_API,
		} as Model<Api>;
		const stream = createAssistantMessageEventStream();
		const partial = createEmptyAssistantMessage(model);
		const projection: RunProjection = { answerText: "", allowToolPreview: true, sdkToOmp: new Map([["read", "read"]]) };
		applyInteractionUpdate(stream, partial, mcpUpdate("tool-call-started", "call-1", "read", { path: "a" }), projection);
		applyInteractionUpdate(stream, partial, mcpUpdate("partial-tool-call", "call-1", "read", { path: "a.ts" }), projection);
		expect(partial.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
		expect(partial.content[0]).toMatchObject({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } });
		applyToolCall(stream, partial, { id: "call-1", name: "read", arguments: { path: "a.ts" } }, projection);
		applyInteractionUpdate(stream, partial, mcpUpdate("tool-call-started", "call-1", "read", { path: "a.ts" }), projection);
		expect(partial.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
		stream.end(partial);
		let argumentsJson = "";
		let starts = 0;
		let ends = 0;
		for await (const event of stream) {
			if (event.type === "toolcall_start") starts += 1;
			if (event.type === "toolcall_delta") argumentsJson += event.delta;
			if (event.type === "toolcall_end") ends += 1;
		}
		expect(starts).toBe(1);
		expect(ends).toBe(1);
		expect(JSON.parse(argumentsJson)).toEqual({ path: "a.ts" });
	});

	test("does not preview unmapped MCP tools and drops unmatched previews", () => {
		const model = {
			id: "composer-2.5",
			provider: CURSOR_SDK_PROVIDER_ID,
			api: CURSOR_SDK_API,
		} as Model<Api>;
		const stream = createAssistantMessageEventStream();
		const partial = createEmptyAssistantMessage(model);
		const projection: RunProjection = { answerText: "", allowToolPreview: true, sdkToOmp: new Map([["read", "read"]]) };
		applyInteractionUpdate(stream, partial, mcpUpdate("tool-call-started", "other", "shellish", { command: "ls" }), projection);
		expect(partial.content.some((block) => block.type === "toolCall")).toBe(false);
		applyInteractionUpdate(stream, partial, mcpUpdate("tool-call-started", "orphan", "read", { path: "x.ts" }), projection);
		applyToolCall(stream, partial, { id: "call-1", name: "read", arguments: { path: "a.ts" } }, projection);
		dropUnendedPreviews(partial, projection, new Set(["call-1"]));
		expect(partial.content.filter((block) => block.type === "toolCall").map((block) => block.type === "toolCall" ? block.id : "")).toEqual(["call-1"]);
		applyToolCall(stream, partial, { id: "orphan", name: "read", arguments: { path: "x.ts" } }, projection);
		expect(partial.content.filter((block) => block.type === "toolCall").map((block) => block.type === "toolCall" ? block.id : "")).toEqual(["call-1", "orphan"]);
	});

	test("does not open executable previews without an explicit park-path allow", () => {
		const model = {
			id: "composer-2.5",
			provider: CURSOR_SDK_PROVIDER_ID,
			api: CURSOR_SDK_API,
		} as Model<Api>;
		const stream = createAssistantMessageEventStream();
		const partial = createEmptyAssistantMessage(model);
		applyInteractionUpdate(stream, partial, mcpUpdate("tool-call-started", "call-1", "read", { path: "a.ts" }), {
			answerText: "",
			sdkToOmp: new Map([["read", "read"]]),
		});
		expect(partial.content).toEqual([]);
	});

	test("projected JSON arguments drive the host streaming edit to change a file", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cursor-projector-edit-"));
		let argStream: AgentToolArgStream | undefined;
		try {
			const path = join(cwd, "example.txt");
			await writeFile(path, "before\n");
			const session: ToolSession = {
				cwd,
				hasUI: false,
				enableLsp: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				settings: Settings.isolated({ "edit.blackbox.enabled": false }),
			};
			const tag = getEditStore(session).recordSnapshot(path, "before\n", [1]);
			const tool = new EditTool(session, "hashline");
			const args = { input: `*** Begin Patch\n[example.txt#${tag}]\nPUT 1.=1:\n+after "quoted" 中文\n*** End Patch\n` };
			const stream = createAssistantMessageEventStream();
			const partial = createEmptyAssistantMessage({ id: "composer-2.5" } as Model<Api>);
			applyInteractionUpdate(stream, partial, { type: "text-delta", text: "Editing." });
			applyToolCall(stream, partial, { id: "edit-1", name: "edit", arguments: args });
			stream.end(partial);

			// The host opens on start, feeds only deltas, then supplies final args to end.
			for await (const event of stream) {
				if (event.type === "toolcall_start") {
					const block = event.partial.content[event.contentIndex];
					if (block.type !== "toolCall") throw new Error("Missing tool call");
					argStream = tool.openArgStream({
						toolCallId: block.id,
						toolName: block.name,
						customWireName: block.customWireName,
						emit: () => {},
					});
				} else if (event.type === "toolcall_delta") {
					argStream!.push(event.delta);
				} else if (event.type === "toolcall_end") {
					argStream!.end(event.toolCall.arguments);
				}
			}
			const result = await tool.execute("edit-1", args);
			expect(result.isError).not.toBe(true);
			expect(await readFile(path, "utf8")).toBe('after "quoted" 中文\n');
		} finally {
			argStream?.cancel();
			await rm(cwd, { recursive: true, force: true });
		}
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
		expect(second.usage).toMatchObject({
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0,
			orchestration: { input: 0, output: 0, cacheRead: 0 },
		});
		projectRunUsage(second, projection, { ...usage, inputTokens: 140, outputTokens: 30, totalTokens: 220, reasoningTokens: 8 });
		expect(first.usage).toMatchObject({
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 170, reasoningTokens: 5,
			orchestration: { input: 110, output: 20, cacheRead: 40 },
		});
		expect(first.usage.contextTokens).toBeUndefined();
		expect(first.cursorSdk.contextOccupancy).toEqual({ status: "unavailable" });
		expect(second.usage).toMatchObject({
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50, reasoningTokens: 3,
			orchestration: { input: 40, output: 10, cacheRead: 0 },
		});
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
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
			orchestration: { input: 2_740_000, output: 20_000, cacheRead: 5_040_000 },
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
			orchestration: { input: 0, output: 0, cacheRead: 0 },
		});
		expect(resumed.cursorSdk.tokenUsage).toBe("actual");
		expect(resumed.cursorSdk.contextOccupancy).toEqual({ status: "unavailable" });
		expect(resumed.usage.contextTokens).toBeUndefined();
	});
});
