import { describe, expect, test } from "bun:test";
import {
	isSdkHostExitCode,
	withSdkExitSuppressed,
	wrapReallyExitForSdk,
} from "../../src/sdk-exit-guard.ts";

class ExtensionExitError extends Error {
	constructor(code: number | string | undefined, alias = "process.reallyExit") {
		super(
			`Module called ${alias}(${code === undefined ? "" : String(code)}) during guarded extension/hook loading; OMP extension/hook modules must not terminate the host process.`,
		);
		this.name = "ExtensionExitError";
	}
}

describe("sdk exit guard", () => {
	test("treats SDK teardown codes 0 and 1 as host-safe", () => {
		expect(isSdkHostExitCode(undefined)).toBe(true);
		expect(isSdkHostExitCode(0)).toBe(true);
		expect(isSdkHostExitCode(1)).toBe(true);
		expect(isSdkHostExitCode(2)).toBe(false);
	});

	test("signal-exit can keep a swallow after OMP restores the real reallyExit", () => {
		const guarded = (code?: number) => {
			throw new ExtensionExitError(code);
		};
		const captured = wrapReallyExitForSdk(guarded);
		expect(() => captured(0)).not.toThrow();
		expect(() => captured(1)).not.toThrow();
		expect(() => captured(2)).toThrow(ExtensionExitError);
	});

	test("withSdkExitSuppressed swallows process.exit(1) from SDK teardown", async () => {
		const original = process.exit;
		try {
			await withSdkExitSuppressed(async () => {
				process.exit(1);
				process.exit(0);
			});
		} finally {
			process.exit = original;
		}
	});
});
