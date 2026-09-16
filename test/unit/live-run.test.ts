import { describe, expect, test } from "bun:test";
import type { Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Run, RunResult } from "@cursor/sdk";
import { createSharedToolExec } from "../../src/host-exec.ts";
import {
	__testUtils as liveRunTestUtils,
	collectParkedBatch,
	createLiveRun,
	disposeLiveRun,
	parkToolCall,
	resumeParked,
	setLiveRun,
	startSend,
	waitForParked,
	waitForResult,
	bindLiveAbort,
	cancelLiveRun,
	waitForCancelled,
} from "../../src/live-run.ts";
import { projectSdkToolCallId } from "../../src/tool-call-id.ts";

function dummyExec() {
	return createSharedToolExec([], async () => ({ content: [], isError: false }), "run-1");
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

describe("live-run park-and-yield", () => {
	test("parks a tool call and resumes from trailing OMP results", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		const parked = waitForParked(live);
		const execution = parkToolCall(live, "read", { path: "a.ts" }, "call-1", "call-1");
		await parked;
		const batch = await collectParkedBatch(live);
		expect(batch.map((call) => ({ sdk: call.sdkToolCallId, omp: call.ompToolCallId }))).toEqual([
			{ sdk: "call-1", omp: "call-1" },
		]);
		resumeParked(live, {
			messages: [toolResult("call-1", "file contents")],
		} as Context);
		await expect(execution).resolves.toEqual({
			isError: false,
			content: [{ type: "text", text: "file contents" }],
		});
	});

	test("keeps late parallel calls parked for the next OMP batch", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		const first = parkToolCall(live, "read", { path: "a.ts" }, "call-first", "call-first");
		await waitForParked(live);
		await collectParkedBatch(live);
		const late = parkToolCall(live, "grep", { pattern: "x" }, "call-late", "call-late");

		resumeParked(live, { messages: [toolResult("call-first", "first")] } as Context);
		await expect(first).resolves.toMatchObject({ content: [{ type: "text", text: "first" }] });
		expect(live.parked.map((call) => call.ompToolCallId)).toEqual(["call-late"]);

		await collectParkedBatch(live);
		resumeParked(live, { messages: [toolResult("call-late", "late")] } as Context);
		await expect(late).resolves.toMatchObject({ content: [{ type: "text", text: "late" }] });
	});

	test("cancel rejects parked calls without executing them", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		setLiveRun("k", live);
		const execution = parkToolCall(live, "bash", { command: "pwd" }, "call-2", "call-2");
		await disposeLiveRun("k", "aborted", false);
		await expect(execution).rejects.toThrow(/aborted/);
	});

	test("startSend parks before send() returns and still finishes after OMP results", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		const send = startSend(live, async () => {
			const result = parkToolCall(live, "read", { path: "a.ts" }, "call-3", "call-3");
			await result;
			return {
				supports: () => false,
				wait: async (): Promise<RunResult> => ({ status: "finished" }) as RunResult,
			} as unknown as Run;
		});
		await waitForParked(live);
		resumeParked(live, { messages: [toolResult("call-3", "ok")] } as Context);
		await expect(waitForResult(live)).resolves.toMatchObject({ status: "finished" });
		await expect(send).resolves.toMatchObject({ status: "finished" });
	});

	test("pre-cancelled send cancels the run once the handle is attached", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		let cancelled = 0;
		const controller = new AbortController();
		controller.abort();
		bindLiveAbort(live, controller.signal);
		const send = startSend(live, async () => {
			return {
				supports: (op: string) => op === "cancel",
				cancel: async () => {
					cancelled += 1;
				},
				wait: async (): Promise<RunResult> => ({ status: "cancelled" }) as RunResult,
			} as unknown as Run;
		});
		await expect(waitForCancelled(live)).resolves.toBeUndefined();
		await expect(send).resolves.toMatchObject({ status: "cancelled" });
		expect(cancelled).toBe(1);
	});

	test("cancel during park rejects callbacks and stays bound after streamSimple would return", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		const execution = parkToolCall(live, "read", { path: "a.ts" }, "call-4", "call-4");
		const controller = new AbortController();
		bindLiveAbort(live, controller.signal);
		controller.abort();
		await expect(execution).rejects.toThrow(/cancelled/);
		await expect(parkToolCall(live, "read", { path: "b.ts" }, "call-5", "call-5")).rejects.toThrow(/cancelled/);
		await cancelLiveRun(live);
	});

	test("resumes parked calls by OMP ID and ignores the SDK-native ID", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		const sdkId = `${"x".repeat(64)}${"y".repeat(23)}`;
		const ompId = projectSdkToolCallId(sdkId);
		const parked = waitForParked(live);
		const execution = parkToolCall(live, "read", { path: "a.ts" }, sdkId, ompId);
		await parked;
		await collectParkedBatch(live);
		resumeParked(live, { messages: [toolResult(sdkId, "should not match")] } as Context);
		await expect(execution).rejects.toThrow(/did not return a tool result/);

		const parkedAgain = waitForParked(live);
		const executionAgain = parkToolCall(live, "read", { path: "a.ts" }, sdkId, ompId);
		await parkedAgain;
		resumeParked(live, { messages: [toolResult(ompId, "file contents")] } as Context);
		await expect(executionAgain).resolves.toEqual({
			isError: false,
			content: [{ type: "text", text: "file contents" }],
		});
	});
});
