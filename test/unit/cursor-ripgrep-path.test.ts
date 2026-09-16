import { accessSync, constants } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { ensureCursorRipgrepPath, resolveBundledCursorRipgrepPath } from "../../src/cursor-ripgrep-path.ts";

const originalRipgrepPath = process.env.CURSOR_RIPGREP_PATH;

afterEach(() => {
	if (originalRipgrepPath === undefined) delete process.env.CURSOR_RIPGREP_PATH;
	else process.env.CURSOR_RIPGREP_PATH = originalRipgrepPath;
});

describe("Cursor ripgrep path", () => {
	test("resolves the installed SDK platform executable", () => {
		const ripgrepPath = resolveBundledCursorRipgrepPath();
		expect(ripgrepPath).toBeDefined();
		expect(() => accessSync(ripgrepPath!, constants.X_OK)).not.toThrow();
	});

	test("sets the environment path without overriding an absolute value", () => {
		process.env.CURSOR_RIPGREP_PATH = "";
		const bundledPath = ensureCursorRipgrepPath();
		expect(process.env.CURSOR_RIPGREP_PATH).toBe(bundledPath);

		process.env.CURSOR_RIPGREP_PATH = "/custom/rg";
		expect(ensureCursorRipgrepPath()).toBe("/custom/rg");
		expect(process.env.CURSOR_RIPGREP_PATH).toBe("/custom/rg");
	});
});
