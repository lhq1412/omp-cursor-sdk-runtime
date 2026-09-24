import { afterEach, expect, jest, test } from "bun:test";
import {
	SETUP_MS,
	WINDOW_MS,
	awaitDeadline,
	awaitPreparation,
	isRetryableNativeProbeFailure,
	observePromise,
	scrub,
} from "../../scripts/sdk-contract-probe.ts";

afterEach(() => {
	if (jest.isFakeTimers()) {
		jest.clearAllTimers();
		jest.useRealTimers();
	}
});

test("setup preparation has its own shared deadline", async () => {
	jest.useFakeTimers();
	jest.setSystemTime(0);

	const entered = Promise.withResolvers<void>();
	const running = Promise.withResolvers<unknown>();
	setTimeout(entered.resolve, WINDOW_MS + 1);
	const slowSetup = observePromise(awaitPreparation(
		observePromise(entered.promise),
		observePromise(running.promise),
		SETUP_MS,
	));
	jest.advanceTimersByTime(WINDOW_MS);
	await Promise.resolve();
	expect(slowSetup.state).toBe("pending");
	jest.advanceTimersByTime(1);
	expect(await slowSetup.promise).toBe("entered");

	jest.clearAllTimers();
	jest.setSystemTime(0);
	const neverEntered = observePromise(new Promise<void>(() => {}));
	const neverFinished = observePromise(new Promise<unknown>(() => {}));
	const timedOut = awaitPreparation(neverEntered, neverFinished, SETUP_MS);
	jest.advanceTimersByTime(SETUP_MS);
	expect(await timedOut).toBe("timeout");

	jest.clearAllTimers();
	jest.setSystemTime(SETUP_MS - WINDOW_MS);
	const remainingSetup = observePromise(awaitPreparation(neverEntered, neverFinished, SETUP_MS));
	jest.advanceTimersByTime(WINDOW_MS - 1);
	await Promise.resolve();
	expect(remainingSetup.state).toBe("pending");
	jest.advanceTimersByTime(1);
	expect(await remainingSetup.promise).toBe("timeout");

	jest.clearAllTimers();
	jest.setSystemTime(0);
	const earlyError = Promise.withResolvers<unknown>();
	const failed = awaitPreparation(
		observePromise(new Promise<void>(() => {})),
		observePromise(earlyError.promise),
		SETUP_MS,
	);
	earlyError.reject(new Error("early run error"));
	expect(await failed).toBe("finished");
});

test("capability observation keeps the ten-second window", async () => {
	jest.useFakeTimers();
	jest.setSystemTime(0);

	const capability = observePromise(new Promise<void>(() => {}));
	const observed = observePromise(awaitDeadline(capability));
	jest.advanceTimersByTime(WINDOW_MS - 1);
	await Promise.resolve();
	expect(observed.state).toBe("pending");
	jest.advanceTimersByTime(1);
	await observed.promise;
	expect(capability.state).toBe("pending");
});

test("empty API keys do not corrupt missing-key diagnostics", () => {
	expect(scrub("CURSOR_API_KEY is required", "")).toBe("CURSOR_API_KEY is required");
	expect(scrub("failed with secret-key", "secret-key")).toBe("failed with <redacted>");
});

test("only isolated custom-tool Agent Looping failures are retried", () => {
	expect(isRetryableNativeProbeFailure([
		{ name: "customToolArgEvents", ok: false, detail: "status=error error=Agent Looping Detected" },
	])).toBe(true);
	expect(isRetryableNativeProbeFailure([
		{ name: "customToolArgEvents", ok: false, detail: "error=Agent Looping Detected" },
		{ name: "resume", ok: false, detail: "agent id changed" },
	])).toBe(false);
	expect(isRetryableNativeProbeFailure([
		{ name: "customToolArgEvents", ok: false, detail: "tool callback not observed" },
	])).toBe(false);
	expect(isRetryableNativeProbeFailure([
		{ name: "customToolArgEvents", ok: true, detail: "ok" },
	])).toBe(false);
});
