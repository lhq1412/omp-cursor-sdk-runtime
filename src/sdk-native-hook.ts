import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
	omitUndefinedArgs,
	piGrepSkip,
	piJoinPath,
	piLimit,
	piLsPath,
	piReadPath,
	piReadPathHasRange,
} from "@oh-my-pi/pi-ai/providers/cursor-pi-args";
import type { HostToolResult } from "./contracts.js";
import { projectSdkToolCallId } from "./tool-call-id.js";

const HOOK = "__cursorSdkNativeToolHook";

function resolveSdkBundle(): string {
	return join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk/package.json")), "dist/bundled/index.js");
}

/** OMP grant name → SDK AgentOptions.tools name. Cursor has no `write` tool; OMP write is native `edit`/`writeArgs`. */
export const NATIVE_OMP_TO_SDK = {
	read: "read",
	grep: "grep",
	bash: "shell",
	edit: "edit",
	glob: "glob",
	write: "edit",
} as const;

/** Extra SDK allowlist names enabled by an OMP grant. Native ls executes as OMP read. */
const NATIVE_OMP_EXTRA_SDK: Record<string, readonly string[]> = {
	read: ["ls"],
};

const TOKEN_TO_OMP = {
	readArgs: "read",
	grepArgs: "grep",
	shellArgs: "bash",
	shellStreamArgs: "bash",
	writeArgs: "write",
	globArgs: "glob",
	GlobToolArgs: "glob",
	piFindArgs: "glob",
	lsArgs: "read",
	piLsArgs: "read",
} as const;

const GLOB_TOKENS = new Set(["globArgs", "GlobToolArgs", "piFindArgs"]);
const LS_TOKENS = new Set(["lsArgs", "piLsArgs"]);
const PI_OUTPUT_TOKENS = new Set(["piFindArgs", "piLsArgs"]);

export type NativeToolExecutor = (name: string, args: Record<string, unknown>, toolCallId: string) => Promise<HostToolResult>;
export type NativeReadExecutor = (args: Record<string, unknown>, toolCallId: string) => Promise<HostToolResult>;

const nativeTools = new AsyncLocalStorage<NativeToolExecutor>();

export function resourceArgsName(token: object): string | undefined {
	const record = token as Record<string, unknown>;
	for (const key of ["remoteImplementation", "registerControlledImplementation"]) {
		const match = /"(\w+Args)"/.exec(String(record[key] ?? ""));
		if (match) return match[1];
	}
	return undefined;
}

export function nativeSdkToolsFromGrants(names: readonly string[]): string[] {
	if (!nativeReadHooked) return [];
	const granted = new Set(names);
	const tools: string[] = [];
	const add = (sdk: string) => {
		if (!tools.includes(sdk)) tools.push(sdk);
	};
	for (const name of names) {
		if (name === "edit" && !granted.has("write")) continue;
		const sdk = NATIVE_OMP_TO_SDK[name as keyof typeof NATIVE_OMP_TO_SDK];
		if (sdk) add(sdk);
		for (const extra of NATIVE_OMP_EXTRA_SDK[name] ?? []) add(extra);
	}
	return tools;
}

export function nativeToolsFingerprint(names: readonly string[]): string {
	return nativeSdkToolsFromGrants(names).toSorted().join(",");
}

export function isHookedOmpTool(name: string, grantedNames?: readonly string[]): boolean {
	if (!nativeReadHooked || !(name in NATIVE_OMP_TO_SDK)) return false;
	if (name === "edit") return Boolean(grantedNames?.includes("write"));
	return true;
}

export const mapNativeReadPath = piReadPath;

function textOf(result: HostToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function str(args: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string") return value;
	}
	return "";
}

function asDetails(details: unknown): Record<string, unknown> | undefined {
	return details && typeof details === "object" ? details as Record<string, unknown> : undefined;
}

function toolResultWasTruncated(details: unknown): boolean {
	const truncation = asDetails(details)?.truncation;
	return !!asDetails(truncation)?.truncated;
}

function toolResultDetailBoolean(details: unknown, key: string): boolean {
	const value = asDetails(details)?.[key];
	return typeof value === "boolean" ? value : false;
}

function readTotalLinesFromDetails(details: unknown): number | undefined {
	const rec = asDetails(details);
	if (!rec) return undefined;
	if (typeof rec.totalLines === "number" && Number.isFinite(rec.totalLines)) return rec.totalLines;
	const truncation = asDetails(asDetails(rec.meta)?.truncation);
	const totalLines = truncation?.totalLines;
	return typeof totalLines === "number" && Number.isFinite(totalLines) ? totalLines : undefined;
}

function readFileSizeFromDetails(details: unknown): number | undefined {
	const fileSize = asDetails(details)?.fileSize;
	return typeof fileSize === "number" && Number.isSafeInteger(fileSize) && fileSize >= 0 ? fileSize : undefined;
}

function grepOutputLines(text: string): string[] {
	return text.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0 && !line.startsWith("[") && !line.toLowerCase().startsWith("no matches"));
}

export function mapGlobArgs(args: Record<string, unknown>): { args: Record<string, unknown> } | { error: string } {
	const pattern = str(args, "globPattern", "glob_pattern", "pattern");
	if (!pattern.trim()) return { error: "glob pattern is required (received an empty pattern)." };
	const dir = str(args, "targetDirectory", "target_directory", "path") || undefined;
	const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? piLimit(args.limit) : undefined;
	return { args: omitUndefinedArgs({ path: piJoinPath(dir, pattern), limit }) };
}

export function ompReadToSdkResult(path: string, result: HostToolResult, rangeApplied = false): object {
	const text = textOf(result);
	if (result.isError) {
		return { result: { case: "error", value: { path, error: text || "read failed" } } };
	}
	const totalLines = readTotalLinesFromDetails(result.details) ?? (rangeApplied ? 0 : text ? text.split("\n").length : 0);
	return {
		result: {
			case: "success",
			value: {
				path,
				output: { case: "content", value: text },
				totalLines,
				fileSize: BigInt(readFileSizeFromDetails(result.details) ?? new TextEncoder().encode(text).byteLength),
				truncated: toolResultWasTruncated(result.details),
				rangeApplied,
			},
		},
	};
}

export function ompGrepToSdkResult(args: Record<string, unknown>, result: HostToolResult): object {
	const pattern = str(args, "pattern");
	const path = str(args, "path") || ".";
	const text = textOf(result);
	if (result.isError) {
		return { result: { case: "error", value: { error: text || "grep failed" } } };
	}
	const outputMode = str(args, "outputMode", "output_mode") || "content";
	const clientTruncated = toolResultDetailBoolean(result.details, "truncated");
	const offsetApplied = typeof args.offset === "number" ? args.offset : undefined;
	const lines = grepOutputLines(text);
	const workspaceKey = path;
	let unionResult: object;
	if (outputMode === "files_with_matches") {
		unionResult = {
			result: {
				case: "files",
				value: omitUndefinedArgs({
					files: lines,
					totalFiles: lines.length,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied,
				}),
			},
		};
	} else if (outputMode === "count") {
		const counts = lines.flatMap((line) => {
			const separatorIndex = line.lastIndexOf(":");
			if (separatorIndex === -1) return [];
			const file = line.slice(0, separatorIndex);
			const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
			if (!file || Number.isNaN(count)) return [];
			return [{ file, count }];
		});
		unionResult = {
			result: {
				case: "count",
				value: omitUndefinedArgs({
					counts,
					totalFiles: counts.length,
					totalMatches: counts.reduce((sum, entry) => sum + entry.count, 0),
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied,
				}),
			},
		};
	} else {
		const matchMap = new Map<string, Array<{ lineNumber: number; content: string; isContextLine: boolean }>>();
		let totalMatchedLines = 0;
		for (const line of lines) {
			const matchLine = line.match(/^(.+?):(\d+):\s?(.*)$/);
			const contextLine = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
			const match = matchLine ?? contextLine;
			if (!match) continue;
			const file = match[1]!;
			const list = matchMap.get(file) ?? [];
			list.push({ lineNumber: Number(match[2]), content: match[3]!, isContextLine: Boolean(contextLine) });
			matchMap.set(file, list);
			if (!contextLine) totalMatchedLines += 1;
		}
		const matches = [...matchMap.entries()].map(([file, fileMatches]) => ({
			file,
			matches: fileMatches.map((entry) => ({ ...entry, contentTruncated: false })),
		}));
		unionResult = {
			result: {
				case: "content",
				value: omitUndefinedArgs({
					matches,
					totalLines: matches.reduce((sum, entry) => sum + entry.matches.length, 0),
					totalMatchedLines,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied,
				}),
			},
		};
	}
	return {
		result: {
			case: "success",
			value: {
				pattern,
				path,
				outputMode,
				workspaceResults: { [workspaceKey]: unionResult },
			},
		},
	};
}

export function ompWriteToSdkResult(path: string, result: HostToolResult, fileText = "", returnFileContentAfterWrite = false): object {
	const text = textOf(result);
	if (result.isError) {
		return { result: { case: "error", value: { path, error: text || "write failed" } } };
	}
	return {
		result: {
			case: "success",
			value: {
				path,
				linesCreated: fileText === "" ? 0 : fileText.split("\n").length,
				fileSize: new TextEncoder().encode(fileText).byteLength,
				...(returnFileContentAfterWrite ? { fileContentAfterWrite: fileText } : {}),
			},
		},
	};
}

export function ompShellToSdkResult(args: Record<string, unknown>, result: HostToolResult): object {
	const command = str(args, "command");
	const workingDirectory = str(args, "workingDirectory", "working_directory");
	const text = textOf(result);
	if (result.isError) {
		return {
			result: {
				case: "failure",
				value: { command, workingDirectory, exitCode: 1, signal: "", stdout: "", stderr: text || "shell failed", executionTime: 0, aborted: false },
			},
		};
	}
	return {
		result: {
			case: "success",
			value: { command, workingDirectory, exitCode: 0, signal: "", stdout: text, stderr: "", executionTime: 0 },
		},
	};
}

export function ompGlobToSdkResult(token: string, args: Record<string, unknown>, result: HostToolResult): object {
	const text = textOf(result);
	if (result.isError) {
		return { result: { case: "error", value: { error: text || "glob failed" } } };
	}
	if (PI_OUTPUT_TOKENS.has(token)) {
		return { result: { case: "success", value: { output: text } } };
	}
	const files = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("["));
	const pattern = str(args, "globPattern", "glob_pattern", "pattern");
	const path = str(args, "targetDirectory", "target_directory", "path") || ".";
	return {
		result: {
			case: "success",
			value: {
				pattern,
				path,
				files,
				totalFiles: files.length,
				clientTruncated: toolResultDetailBoolean(result.details, "truncated"),
				ripgrepTruncated: false,
			},
		},
	};
}

export function ompLsToSdkResult(token: string, path: string, result: HostToolResult): object {
	const text = textOf(result);
	if (result.isError) {
		return token === "lsArgs"
			? { result: { case: "error", value: { path, error: text || "ls failed" } } }
			: { result: { case: "error", value: { error: text || "ls failed" } } };
	}
	if (PI_OUTPUT_TOKENS.has(token)) {
		return { result: { case: "success", value: { output: text } } };
	}
	const rootPath = path || ".";
	const dirs: Array<{ absPath: string; childrenDirs: unknown[]; childrenFiles: unknown[]; childrenWereProcessed: boolean; fullSubtreeExtensionCounts: Record<string, number>; numFiles: number }> = [];
	const files: Array<{ name: string }> = [];
	for (const entry of text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("["))) {
		const name = entry.split(" (")[0]!;
		if (name.endsWith("/")) {
			const dirName = name.slice(0, -1);
			dirs.push({
				absPath: `${rootPath.replace(/\/$/, "")}/${dirName}`,
				childrenDirs: [],
				childrenFiles: [],
				childrenWereProcessed: false,
				fullSubtreeExtensionCounts: {},
				numFiles: 0,
			});
		} else {
			files.push({ name });
		}
	}
	return {
		result: {
			case: "success",
			value: {
				directoryTreeRoot: {
					absPath: rootPath,
					childrenDirs: dirs,
					childrenFiles: files,
					childrenWereProcessed: true,
					fullSubtreeExtensionCounts: {},
					numFiles: files.length,
				},
			},
		},
	};
}

function mapGrepArgs(args: Record<string, unknown>): { args: Record<string, unknown> } | { error: string } {
	const pattern = str(args, "pattern");
	const glob = str(args, "glob");
	if (!pattern.trim()) {
		return { error: glob ? `grep pattern is required (received an empty pattern). To list files matching "${glob}", pass a non-empty regex (e.g. ".") and set path to that glob, or use the ls/read tool instead.` : "grep pattern is required (received an empty pattern)." };
	}
	const path = str(args, "path");
	return {
		args: omitUndefinedArgs({
			pattern,
			path: glob ? piJoinPath(path || ".", glob) : path || ".",
			case: (args.caseInsensitive ?? args.case_insensitive) === true ? false : undefined,
			skip: piGrepSkip(typeof args.offset === "number" ? args.offset : undefined),
		}),
	};
}

function mapShellArgs(args: Record<string, unknown>): Record<string, unknown> {
	return omitUndefinedArgs({
		command: str(args, "command"),
		cwd: str(args, "workingDirectory", "working_directory") || undefined,
		timeout: typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : undefined,
	});
}

function unavailable(token: string, args: Record<string, unknown>): object {
	const path = str(args, "path") || str(args, "targetDirectory", "target_directory");
	const command = str(args, "command");
	if (token === "readArgs" || token === "writeArgs" || token === "lsArgs") {
		return { result: { case: "rejected", value: { path, reason: "OMP host unavailable" } } };
	}
	if (token === "shellArgs" || token === "shellStreamArgs") {
		return { result: { case: "rejected", value: { command, workingDirectory: str(args, "workingDirectory", "working_directory"), reason: "OMP host unavailable" } } };
	}
	return { result: { case: "error", value: { error: "OMP host unavailable" } } };
}

async function executeNative(token: string, args: Record<string, unknown>): Promise<object> {
	const run = nativeTools.getStore();
	if (!run) return unavailable(token, args);
	const toolCallId = str(args, "toolCallId", "tool_call_id");
	const execId = toolCallId ? projectSdkToolCallId(`${toolCallId}:${token}`) : toolCallId;
	try {
		if (token === "readArgs") {
			const path = str(args, "path");
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			const mapped = piReadPath(path, offset, limit);
			if (mapped === null) {
				return ompReadToSdkResult(path, { content: [{ type: "text", text: "" }], isError: false });
			}
			return ompReadToSdkResult(
				path,
				await run("read", { path: mapped }, execId),
				offset !== undefined || limit !== undefined || piReadPathHasRange(mapped),
			);
		}
		if (token === "grepArgs") {
			const prepared = mapGrepArgs(args);
			if ("error" in prepared) return ompGrepToSdkResult(args, { content: [{ type: "text", text: prepared.error }], isError: true });
			return ompGrepToSdkResult(args, await run("grep", prepared.args, execId));
		}
		if (token === "shellArgs" || token === "shellStreamArgs") {
			return ompShellToSdkResult(args, await run("bash", mapShellArgs(args), execId));
		}
		if (GLOB_TOKENS.has(token)) {
			const prepared = mapGlobArgs(args);
			if ("error" in prepared) {
				return ompGlobToSdkResult(token, args, { content: [{ type: "text", text: prepared.error }], isError: true });
			}
			return ompGlobToSdkResult(token, args, await run("glob", prepared.args, execId));
		}
		if (LS_TOKENS.has(token)) {
			const path = piLsPath(str(args, "path") || undefined);
			return ompLsToSdkResult(token, path, await run("read", { path }, execId));
		}
		const path = str(args, "path");
		const content = str(args, "fileText", "file_text")
			|| (args.fileBytes instanceof Uint8Array ? new TextDecoder().decode(args.fileBytes) : "");
		return ompWriteToSdkResult(path, await run("write", { path, content }, execId), content, args.returnFileContentAfterWrite === true);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return ompToError(token, args, message);
	}
}

function ompToError(token: string, args: Record<string, unknown>, message: string): object {
	const path = str(args, "path") || str(args, "targetDirectory", "target_directory");
	if (token === "readArgs" || token === "writeArgs" || token === "lsArgs") {
		return { result: { case: "error", value: { path, error: message } } };
	}
	if (token === "shellArgs" || token === "shellStreamArgs") {
		return ompShellToSdkResult(args, { content: [{ type: "text", text: message }], isError: true });
	}
	return { result: { case: "error", value: { error: message } } };
}

async function* executeNativeShellStream(args: Record<string, unknown>): AsyncGenerator<object> {
	const result = await executeNative("shellArgs", args) as { result?: { case?: string; value?: Record<string, unknown> } };
	const envelope = result.result;
	if (envelope?.case === "success") {
		const stdout = String(envelope.value?.stdout ?? "");
		const stderr = String(envelope.value?.stderr ?? "");
		if (stdout) yield { event: { case: "stdout", value: { data: stdout } } };
		if (stderr) yield { event: { case: "stderr", value: { data: stderr } } };
		yield { event: { case: "exit", value: { code: Number(envelope.value?.exitCode ?? 0), aborted: false } } };
		return;
	}
	const reason = envelope?.case === "failure" ? String(envelope.value?.stderr || "shell failed") : (envelope?.case ?? "OMP host unavailable");
	yield {
		event: {
			case: "rejected",
			value: { command: str(args, "command"), workingDirectory: str(args, "workingDirectory", "working_directory"), reason },
		},
	};
}

function installHook(): void {
	(globalThis as Record<string, unknown>)[HOOK] = (runtime: {
		resources?: {
			base?: {
				register: (token: object, impl: object) => void;
				entries: () => Iterable<[object, { execute?: (...args: unknown[]) => unknown }]>;
				__ompNativeToolsHooked?: boolean;
			};
		};
	}) => {
		const base = runtime.resources?.base;
		if (!base || base.__ompNativeToolsHooked) return;
		base.__ompNativeToolsHooked = true;
		const wrap = (token: object, impl: { execute?: (...args: unknown[]) => unknown }) => {
			const name = resourceArgsName(token);
			if (!name || !(name in TOKEN_TO_OMP) || typeof impl.execute !== "function") return impl;
			impl.execute = name === "shellStreamArgs"
				? (_ctx: unknown, args: unknown) => executeNativeShellStream(asArgs(args))
				: (_ctx: unknown, args: unknown) => executeNative(name, asArgs(args));
			return impl;
		};
		const origReg = base.register.bind(base);
		base.register = (token, impl) => origReg(token, wrap(token, impl));
		for (const [token, impl] of base.entries()) wrap(token, impl);
	};
}

function asArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

let nativeBundlePatched = false;
export let nativeReadHooked = false;
try {
	const bundle = resolveSdkBundle();
	const orig = readFileSync(bundle, "utf8");
	if (!orig.includes(`globalThis.${HOOK}`)) {
		const patched = orig
			.replace("wG8(s,i.customTools);", `wG8(s,i.customTools);globalThis.${HOOK}?.(s);`)
			.replace("wG8(j,i.customTools),", `wG8(j,i.customTools),globalThis.${HOOK}?.(j),`);
		if (patched !== orig) writeFileSync(bundle, patched);
		else throw new Error("cursor sdk native hook site missing");
	}
	installHook();
	nativeBundlePatched = true;
	nativeReadHooked = true;
} catch {
	nativeBundlePatched = false;
	nativeReadHooked = false;
}

export const __testUtils = {
	executeNative,
	setNativeHooked(value: boolean) {
		nativeReadHooked = value;
	},
	resetNativeHooked() {
		nativeReadHooked = nativeBundlePatched;
	},
};

export function runWithNativeTools<T>(execute: NativeToolExecutor, fn: () => T): T {
	return nativeTools.run(execute, fn);
}

export function runWithNativeRead<T>(execute: NativeReadExecutor, fn: () => T): T {
	return runWithNativeTools(async (_name, args, toolCallId) => execute(args, toolCallId), fn);
}
