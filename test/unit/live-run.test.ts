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
} from "../../src/live-run.ts";

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
		const execution = parkToolCall(live, "read", { path: "a.ts" }, "call-1");
		await parked;
		const batch = await collectParkedBatch(live);
		expect(batch.map((call) => call.toolCallId)).toEqual(["call-1"]);
		resumeParked(live, {
			messages: [toolResult("call-1", "file contents")],
		} as Context);
		await expect(execution).resolves.toEqual({
			isError: false,
			content: [{ type: "text", text: "file contents" }],
		});
	});

	test("cancel rejects parked calls without executing them", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		setLiveRun("k", live);
		const execution = parkToolCall(live, "bash", { command: "pwd" }, "call-2");
		await disposeLiveRun("k", "aborted", false);
		await expect(execution).rejects.toThrow(/aborted/);
	});

	test("startSend parks before send() returns and still finishes after OMP results", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		const send = startSend(live, async () => {
			const result = parkToolCall(live, "read", { path: "a.ts" }, "call-3");
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
});
