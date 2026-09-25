import { describe, expect, test } from "bun:test";
import type { Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Run, RunResult } from "@cursor/sdk";
import { createSharedToolExec } from "../../src/host-exec.ts";
import {
	__testUtils as liveRunTestUtils,
	activeWaiterCount,
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
		await parked.promise;
		parked.dispose();
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
		await waitForParked(live).promise;
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
		await waitForParked(live).promise;
		resumeParked(live, { messages: [toolResult("call-3", "ok")] } as Context);
		await expect(waitForResult(live).promise).resolves.toMatchObject({ status: "finished" });
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
		await expect(waitForCancelled(live).promise).resolves.toBeUndefined();
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
		await parked.promise;
		parked.dispose();
		await collectParkedBatch(live);
		resumeParked(live, { messages: [toolResult(sdkId, "should not match")] } as Context);
		await expect(execution).rejects.toThrow(/did not return a tool result/);

		const parkedAgain = waitForParked(live);
		const executionAgain = parkToolCall(live, "read", { path: "a.ts" }, sdkId, ompId);
		await parkedAgain.promise;
		parkedAgain.dispose();
		resumeParked(live, { messages: [toolResult(ompId, "file contents")] } as Context);
		await expect(executionAgain).resolves.toEqual({
			isError: false,
			content: [{ type: "text", text: "file contents" }],
		});
	});

	test("dispose clears cancel and result waiters without growing across races", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		const handles = Array.from({ length: 20 }, () => ({
			cancelled: waitForCancelled(live),
			result: waitForResult(live),
			parked: waitForParked(live),
		}));
		expect(activeWaiterCount(live)).toBe(60);
		for (const handle of handles) {
			handle.cancelled.dispose();
			handle.result.dispose();
			handle.parked.dispose();
		}
		expect(activeWaiterCount(live)).toBe(0);
	});

	test("1000 local wait/resume cycles keep active waiters bounded to the current race", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		startSend(live, async () => ({
			supports: () => false,
			wait: () => new Promise<RunResult>(() => undefined),
		} as unknown as Run));

		let peak = 0;
		for (let i = 0; i < 1000; i += 1) {
			const parked = waitForParked(live);
			const finished = waitForResult(live);
			const cancelled = waitForCancelled(live);
			peak = Math.max(peak, activeWaiterCount(live));
			const execution = parkToolCall(live, "read", { path: `f-${i}.ts` }, `sdk-${i}`, `omp-${i}`);
			await parked.promise;
			parked.dispose();
			finished.dispose();
			cancelled.dispose();
			expect(activeWaiterCount(live)).toBe(0);
			const call = live.parked[0]!;
			call.yielded = true;
			resumeParked(live, {
				messages: [toolResult(call.ompToolCallId, "ok")],
			} as Context);
			await expect(execution).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
		}
		expect(peak).toBeLessThanOrEqual(3);
		expect(activeWaiterCount(live)).toBe(0);
	});

	test("cached result terminal serves later waiters immediately", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		const send = startSend(live, async () => ({
			supports: () => false,
			wait: async (): Promise<RunResult> => ({ status: "finished" }) as RunResult,
		} as unknown as Run));
		await send;
		const late = waitForResult(live);
		await expect(late.promise).resolves.toMatchObject({ status: "finished" });
		late.dispose();
		expect(activeWaiterCount(live)).toBe(0);
	});

	test("old cancel waiters do not fire after dispose when a new run is cancelled", async () => {
		liveRunTestUtils.clear();
		const oldLive = createLiveRun(dummyExec());
		const stale = waitForCancelled(oldLive);
		let staleFired = false;
		void stale.promise.then(() => {
			staleFired = true;
		});
		stale.dispose();
		const fresh = createLiveRun(dummyExec());
		const freshWait = waitForCancelled(fresh);
		await cancelLiveRun(fresh);
		await freshWait.promise;
		await Promise.resolve();
		expect(staleFired).toBe(false);
		await cancelLiveRun(oldLive);
		expect(staleFired).toBe(false);
	});

	test("repeated cancel and dispose do not throw or leave waiters", async () => {
		liveRunTestUtils.clear();
		const live = createLiveRun(dummyExec());
		setLiveRun("dup", live);
		const wait = waitForCancelled(live);
		await cancelLiveRun(live);
		await cancelLiveRun(live);
		await disposeLiveRun("dup", "gone", false);
		await disposeLiveRun("dup", "gone", false);
		await expect(wait.promise).resolves.toBeUndefined();
		expect(activeWaiterCount(live)).toBe(0);
	});
});
