import { describe, expect, test } from "bun:test";
import { mapGlobArgs, mapNativeReadPath, nativeSdkToolsFromGrants, ompGlobToSdkResult, ompGrepToSdkResult, ompLsToSdkResult, ompReadToSdkResult, ompShellToSdkResult, ompWriteToSdkResult, resourceArgsName, runWithNativeTools, __testUtils as nativeHookTestUtils } from "../../src/sdk-native-hook.ts";
import { projectSdkToolCallId } from "../../src/tool-call-id.ts";

describe("resourceArgsName", () => {
	test("reads the Args name from remoteImplementation source", () => {
		const token = {
			symbol: Symbol("read"),
			remoteImplementation: ($) => new Object($, "readArgs", "readResult"),
		};
		expect(resourceArgsName(token)).toBe("readArgs");
	});

	test("reads GlobToolArgs and piFindArgs names", () => {
		expect(resourceArgsName({ remoteImplementation: () => "GlobToolArgs" })).toBe("GlobToolArgs");
		expect(resourceArgsName({ remoteImplementation: () => 'x1("piFindArgs")' })).toBe("piFindArgs");
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

	test("does not report window size as totalLines for a ranged read", () => {
		expect(ompReadToSdkResult("/tmp/a.ts", {
			content: [{ type: "text", text: "a\nb\nc" }],
			isError: false,
		}, true)).toMatchObject({
			result: { case: "success", value: { totalLines: 0, rangeApplied: true, output: { case: "content", value: "a\nb\nc" } } },
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
	test("parses file:line:content matches like the OMP Cursor provider", () => {
		expect(ompGrepToSdkResult({ pattern: "ab", path: "src" }, {
			content: [{ type: "text", text: "src/a.ts:1:ab\nsrc/a.ts-2-cd" }],
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
									matches: [{
										file: "src/a.ts",
										matches: [
											{ lineNumber: 1, content: "ab", contentTruncated: false, isContextLine: false },
											{ lineNumber: 2, content: "cd", contentTruncated: false, isContextLine: true },
										],
									}],
									totalLines: 2,
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

	test("parses OMP hashline grep output into file matches", () => {
		expect(ompGrepToSdkResult({ pattern: "cursor-sdk", path: "package.json" }, {
			content: [{ type: "text", text: "[package.json#0FD0]\n 11:    \"cursor\",\n*12:    \"cursor-sdk\"\n 13:  ]," }],
			isError: false,
			details: { truncated: false, files: ["package.json"] },
		})).toMatchObject({
			result: {
				case: "success",
				value: {
					workspaceResults: {
						"package.json": {
							result: {
								case: "content",
								value: {
									matches: [{
										file: "package.json",
										matches: [
											{ lineNumber: 11, content: "    \"cursor\",", isContextLine: true },
											{ lineNumber: 12, content: "    \"cursor-sdk\"", isContextLine: false },
											{ lineNumber: 13, content: "  ],", isContextLine: true },
										],
									}],
									totalMatchedLines: 1,
									clientTruncated: false,
								},
							},
						},
					},
				},
			},
		});
	});

	test("parses grouped OMP grep headers into file paths", () => {
		const result = ompGrepToSdkResult({ pattern: ".", path: "." }, {
			content: [{ type: "text", text: "# src/\n## auth.ts#50A5\n*1:import { createHash } from \"node:crypto\";" }],
			isError: false,
		});
		expect(result).toMatchObject({
			result: {
				case: "success",
				value: {
					workspaceResults: {
						".": {
							result: {
								case: "content",
								value: {
									matches: [{
										file: "src/auth.ts",
										matches: [{ lineNumber: 1, isContextLine: false }],
									}],
									totalMatchedLines: 1,
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
			content: [{ type: "text", text: "Wrote file" }],
			isError: false,
		}, "ab\nc")).toEqual({
			result: {
				case: "success",
				value: { path: "/tmp/a.ts", linesCreated: 2, fileSize: 4 },
			},
		});
		expect(ompWriteToSdkResult("/tmp/a.ts", {
			content: [{ type: "text", text: "Wrote file" }],
			isError: false,
		}, "ab\nc", true)).toMatchObject({
			result: { case: "success", value: { fileContentAfterWrite: "ab\nc" } },
		});
	});

	test("maps host errors onto the write error envelope", () => {
		expect(ompWriteToSdkResult("/tmp/a.ts", {
			content: [{ type: "text", text: "denied" }],
			isError: true,
		})).toEqual({ result: { case: "error", value: { path: "/tmp/a.ts", error: "denied" } } });
	});
});

describe("mapGlobArgs", () => {
	test("joins targetDirectory and globPattern onto OMP path", () => {
		expect(mapGlobArgs({ globPattern: "**/*.ts", targetDirectory: "src" })).toEqual({ args: { path: "src/**/*.ts" } });
	});

	test("uses a lone pattern as the OMP path", () => {
		expect(mapGlobArgs({ pattern: "*.md" })).toEqual({ args: { path: "*.md" } });
	});

	test("rejects an empty pattern", () => {
		expect(mapGlobArgs({ globPattern: "  ", targetDirectory: "src" })).toEqual({
			error: "glob pattern is required (received an empty pattern).",
		});
	});

	test("clamps a present limit to at least 1", () => {
		expect(mapGlobArgs({ globPattern: "*", limit: 0 })).toEqual({ args: { path: "*", limit: 1 } });
	});
});

describe("ompGlobToSdkResult", () => {
	test("maps host lines onto GlobToolSuccess files", () => {
		expect(ompGlobToSdkResult("GlobToolArgs", { globPattern: "*.ts", targetDirectory: "src" }, {
			content: [{ type: "text", text: "src/a.ts\nsrc/b.ts\n" }],
			isError: false,
		})).toEqual({
			result: {
				case: "success",
				value: {
					pattern: "*.ts",
					path: "src",
					files: ["src/a.ts", "src/b.ts"],
					totalFiles: 2,
					clientTruncated: false,
					ripgrepTruncated: false,
				},
			},
		});
	});

	test("maps piFind onto an output string", () => {
		expect(ompGlobToSdkResult("piFindArgs", { pattern: "*.ts" }, {
			content: [{ type: "text", text: "a.ts" }],
			isError: false,
		})).toEqual({ result: { case: "success", value: { output: "a.ts" } } });
	});

	test("maps host errors onto the glob error envelope", () => {
		expect(ompGlobToSdkResult("GlobToolArgs", { globPattern: "*" }, {
			content: [{ type: "text", text: "denied" }],
			isError: true,
		})).toEqual({ result: { case: "error", value: { error: "denied" } } });
	});
});

describe("ompLsToSdkResult", () => {
	test("maps a directory listing onto a flat tree", () => {
		expect(ompLsToSdkResult("lsArgs", "src", {
			content: [{ type: "text", text: "a.ts (1.2k)\nlib/\n[3 more]\n" }],
			isError: false,
		})).toEqual({
			result: {
				case: "success",
				value: {
					directoryTreeRoot: {
						absPath: "src",
						childrenDirs: [{
							absPath: "src/lib",
							childrenDirs: [],
							childrenFiles: [],
							childrenWereProcessed: false,
							fullSubtreeExtensionCounts: {},
							numFiles: 0,
						}],
						childrenFiles: [{ name: "a.ts" }],
						childrenWereProcessed: true,
						fullSubtreeExtensionCounts: {},
						numFiles: 1,
					},
				},
			},
		});
	});

	test("maps piLs onto an output string", () => {
		expect(ompLsToSdkResult("piLsArgs", ".", {
			content: [{ type: "text", text: "a.ts" }],
			isError: false,
		})).toEqual({ result: { case: "success", value: { output: "a.ts" } } });
	});
});

describe("nativeSdkToolsFromGrants", () => {
	test("maps OMP grants onto SDK names and adds ls from read", () => {
		expect(nativeSdkToolsFromGrants(["read", "glob", "write", "bash"])).toEqual(
			expect.arrayContaining(["read", "ls", "glob", "edit", "shell"]),
		);
		expect(nativeSdkToolsFromGrants(["read", "glob", "write", "bash"])).not.toContain("write");
	});

	test("does not advertise native edit without an OMP write grant", () => {
		expect(nativeSdkToolsFromGrants(["edit"])).not.toContain("edit");
		expect(nativeSdkToolsFromGrants(["write"])).toEqual(["edit"]);
	});
});

describe("executeNative", () => {
	test("sends ranged reads as an OMP path selector and projects the exec id", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown>; id: string }> = [];
		const sdkId = "x".repeat(87);
		await runWithNativeTools(async (name, args, id) => {
			calls.push({ name, args, id });
			return { content: [{ type: "text", text: "line" }], isError: false };
		}, () => nativeHookTestUtils.executeNative("readArgs", { path: "src/a.ts", offset: 10, limit: 5, toolCallId: sdkId }));
		expect(calls).toEqual([{
			name: "read",
			args: { path: "src/a.ts:raw:10+5" },
			id: projectSdkToolCallId(`${sdkId}:readArgs`),
		}]);
	});

	test("computes write metadata from fileText not the host message", async () => {
		const result = await runWithNativeTools(async () => {
			return { content: [{ type: "text", text: "Wrote file" }], isError: false };
		}, () => nativeHookTestUtils.executeNative("writeArgs", { path: "/tmp/a.ts", fileText: "ab\nc", toolCallId: "call1" }));
		expect(result).toEqual({
			result: {
				case: "success",
				value: { path: "/tmp/a.ts", linesCreated: 2, fileSize: 4 },
			},
		});
	});

	test("forwards grep offset as OMP skip and joins glob onto path", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		await runWithNativeTools(async (name, args) => {
			calls.push({ name, args });
			return { content: [{ type: "text", text: "src/a.ts:1:ab" }], isError: false };
		}, () => nativeHookTestUtils.executeNative("grepArgs", {
			pattern: "ab",
			path: "src",
			glob: "*.ts",
			offset: 3,
			caseInsensitive: true,
			toolCallId: "g1",
		}));
		expect(calls).toEqual([{
			name: "grep",
			args: { pattern: "ab", path: "src/*.ts", case: false, skip: 3 },
		}]);
	});
});
