import { describe, expect, test } from "bun:test";
import { mapNativeReadPath, ompGrepToSdkResult, ompReadToSdkResult, ompShellToSdkResult, ompWriteToSdkResult, resourceArgsName } from "../../src/sdk-native-hook.ts";

describe("resourceArgsName", () => {
	test("reads the Args name from remoteImplementation source", () => {
		const token = {
			symbol: Symbol("read"),
			remoteImplementation: ($) => new Object($, "readArgs", "readResult"),
		};
		expect(resourceArgsName(token)).toBe("readArgs");
	});

	test("ignores tokens without an Args signature", () => {
		expect(resourceArgsName({ symbol: Symbol("x"), remoteImplementation: () => undefined })).toBeUndefined();
	});
});

describe("mapNativeReadPath", () => {
	test("keeps a whole-file path", () => {
		expect(mapNativeReadPath("src/a.ts")).toBe("src/a.ts");
	});

	test("composes raw range selectors", () => {
		expect(mapNativeReadPath("src/a.ts", 10, 5)).toBe("src/a.ts:raw:10+5");
		expect(mapNativeReadPath("src/a.ts", undefined, 3)).toBe("src/a.ts:raw:1+3");
		expect(mapNativeReadPath("src/a.ts", 4)).toBe("src/a.ts:raw:4-");
	});

	test("treats non-positive limit as empty", () => {
		expect(mapNativeReadPath("src/a.ts", 1, 0)).toBeNull();
	});
});

describe("ompReadToSdkResult", () => {
	test("maps success text onto the proto success envelope", () => {
		expect(ompReadToSdkResult("/tmp/a.ts", {
			content: [{ type: "text", text: "ab\nc" }],
			isError: false,
		})).toEqual({
			result: {
				case: "success",
				value: {
					path: "/tmp/a.ts",
					output: { case: "content", value: "ab\nc" },
					totalLines: 2,
					fileSize: 4n,
					truncated: false,
					rangeApplied: false,
				},
			},
		});
	});

	test("maps host errors onto the proto error envelope", () => {
		expect(ompReadToSdkResult("/tmp/a.ts", {
			content: [{ type: "text", text: "missing" }],
			isError: true,
		})).toEqual({
			result: { case: "error", value: { path: "/tmp/a.ts", error: "missing" } },
		});
	});
});

describe("ompGrepToSdkResult", () => {
	test("wraps host text as a content match", () => {
		expect(ompGrepToSdkResult({ pattern: "ab", path: "src" }, {
			content: [{ type: "text", text: "src/a.ts:1:ab" }],
			isError: false,
		})).toEqual({
			result: {
				case: "success",
				value: {
					pattern: "ab",
					path: "src",
					outputMode: "content",
					workspaceResults: {
						src: {
							result: {
								case: "content",
								value: {
									matches: [{ file: "src", matches: [{ lineNumber: 1, content: "src/a.ts:1:ab", contentTruncated: false, isContextLine: false }] }],
									totalLines: 1,
									totalMatchedLines: 1,
									clientTruncated: false,
									ripgrepTruncated: false,
								},
							},
						},
					},
				},
			},
		});
	});

	test("maps host errors onto the grep error envelope", () => {
		expect(ompGrepToSdkResult({ pattern: "x" }, {
			content: [{ type: "text", text: "bad pattern" }],
			isError: true,
		})).toEqual({ result: { case: "error", value: { error: "bad pattern" } } });
	});
});

describe("ompShellToSdkResult", () => {
	test("puts host text on stdout", () => {
		expect(ompShellToSdkResult({ command: "echo hi", workingDirectory: "/tmp" }, {
			content: [{ type: "text", text: "hi\n" }],
			isError: false,
		})).toEqual({
			result: {
				case: "success",
				value: { command: "echo hi", workingDirectory: "/tmp", exitCode: 0, signal: "", stdout: "hi\n", stderr: "", executionTime: 0 },
			},
		});
	});

	test("maps host errors onto failure stderr", () => {
		expect(ompShellToSdkResult({ command: "false" }, {
			content: [{ type: "text", text: "exit 1" }],
			isError: true,
		})).toMatchObject({
			result: { case: "failure", value: { exitCode: 1, stderr: "exit 1" } },
		});
	});
});

describe("ompWriteToSdkResult", () => {
	test("maps success onto the write envelope", () => {
		expect(ompWriteToSdkResult("/tmp/a.ts", {
			content: [{ type: "text", text: "ab\nc" }],
			isError: false,
		})).toEqual({
			result: {
				case: "success",
				value: { path: "/tmp/a.ts", linesCreated: 2, fileSize: 4 },
			},
		});
	});

	test("maps host errors onto the write error envelope", () => {
		expect(ompWriteToSdkResult("/tmp/a.ts", {
			content: [{ type: "text", text: "denied" }],
			isError: true,
		})).toEqual({ result: { case: "error", value: { path: "/tmp/a.ts", error: "denied" } } });
	});
});
