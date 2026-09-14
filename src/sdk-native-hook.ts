import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import type { HostToolResult } from "./contracts.js";

const HOOK = "__cursorSdkNativeToolHook";
const BUNDLE = new URL("../node_modules/@cursor/sdk/dist/bundled/index.js", import.meta.url);

/** OMP grant name → SDK AgentOptions.tools name. Native edit executes as writeArgs. */
export const NATIVE_OMP_TO_SDK = {
	read: "read",
	grep: "grep",
	bash: "shell",
	edit: "edit",
} as const;

const TOKEN_TO_OMP = {
	readArgs: "read",
	grepArgs: "grep",
	shellArgs: "bash",
	shellStreamArgs: "bash",
	writeArgs: "write",
} as const;

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
	const tools: string[] = [];
	for (const name of names) {
		const sdk = NATIVE_OMP_TO_SDK[name as keyof typeof NATIVE_OMP_TO_SDK];
		if (sdk && !tools.includes(sdk)) tools.push(sdk);
	}
	return tools;
}

export function isHookedOmpTool(name: string): boolean {
	return nativeReadHooked && name in NATIVE_OMP_TO_SDK;
}

export function mapNativeReadPath(path: string, offset?: number, limit?: number): string | null {
	if (limit !== undefined && Math.floor(limit) <= 0) return null;
	const start = offset !== undefined ? Math.max(1, Math.floor(offset)) : undefined;
	const count = limit !== undefined ? Math.floor(limit) : undefined;
	if (start === undefined && count === undefined) return path;
	const base = path.split(":").some((chunk) => chunk.toLowerCase() === "raw") ? path : `${path}:raw`;
	if (start === undefined) return `${base}:1+${count}`;
	return count === undefined ? `${base}:${start}-` : `${base}:${start}+${count}`;
}

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

export function ompReadToSdkResult(path: string, result: HostToolResult): object {
	const text = textOf(result);
	if (result.isError) {
		return { result: { case: "error", value: { path, error: text || "read failed" } } };
	}
	const totalLines = text === "" ? 0 : text.split("\n").length;
	return {
		result: {
			case: "success",
			value: {
				path,
				output: { case: "content", value: text },
				totalLines,
				fileSize: BigInt(new TextEncoder().encode(text).byteLength),
				truncated: false,
				rangeApplied: false,
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
	const lines = text === "" ? 0 : text.split("\n").length;
	return {
		result: {
			case: "success",
			value: {
				pattern,
				path,
				outputMode: "content",
				workspaceResults: {
					[path]: {
						result: {
							case: "content",
							value: {
								matches: [{ file: path, matches: [{ lineNumber: 1, content: text, contentTruncated: false, isContextLine: false }] }],
								totalLines: lines,
								totalMatchedLines: lines,
								clientTruncated: false,
								ripgrepTruncated: false,
							},
						},
					},
				},
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

export function ompWriteToSdkResult(path: string, result: HostToolResult): object {
	const text = textOf(result);
	if (result.isError) {
		return { result: { case: "error", value: { path, error: text || "write failed" } } };
	}
	const linesCreated = text === "" ? 0 : text.split("\n").length;
	return {
		result: {
			case: "success",
			value: { path, linesCreated, fileSize: new TextEncoder().encode(text).byteLength },
		},
	};
}

function optionalLine(value: unknown): number | undefined {
	return typeof value === "number" && value !== 0 ? value : undefined;
}

function mapGrepArgs(args: Record<string, unknown>): { args: Record<string, unknown> } | { error: string } {
	const pattern = str(args, "pattern");
	const glob = str(args, "glob");
	if (!pattern.trim()) {
		return { error: glob ? `grep pattern is required (received an empty pattern). To list files matching "${glob}", pass a non-empty regex (e.g. ".") and set path to that glob, or use the ls/read tool instead.` : "grep pattern is required (received an empty pattern)." };
	}
	const path = str(args, "path");
	const mapped: Record<string, unknown> = { pattern };
	if (glob) mapped.path = `${path || "."}/${glob}`;
	else if (path) mapped.path = path;
	const insensitive = args.caseInsensitive ?? args.case_insensitive;
	if (insensitive === true) mapped.case = false;
	else if (insensitive === false) mapped.case = true;
	return { args: mapped };
}

function mapShellArgs(args: Record<string, unknown>): Record<string, unknown> {
	const mapped: Record<string, unknown> = { command: str(args, "command") };
	const cwd = str(args, "workingDirectory", "working_directory");
	if (cwd) mapped.cwd = cwd;
	const timeout = args.timeout;
	if (typeof timeout === "number" && timeout > 0) {
		mapped.timeout = timeout > 3600 ? Math.ceil(timeout / 1000) : timeout;
	}
	return mapped;
}

function unavailable(token: string, args: Record<string, unknown>): object {
	const path = str(args, "path");
	const command = str(args, "command");
	if (token === "readArgs") return { result: { case: "rejected", value: { path, reason: "OMP host unavailable" } } };
	if (token === "writeArgs") return { result: { case: "rejected", value: { path, reason: "OMP host unavailable" } } };
	if (token === "shellArgs" || token === "shellStreamArgs") {
		return { result: { case: "rejected", value: { command, workingDirectory: str(args, "workingDirectory", "working_directory"), reason: "OMP host unavailable" } } };
	}
	return { result: { case: "error", value: { error: "OMP host unavailable" } } };
}

async function executeNative(token: string, args: Record<string, unknown>): Promise<object> {
	const run = nativeTools.getStore();
	if (!run) return unavailable(token, args);
	const toolCallId = str(args, "toolCallId", "tool_call_id");
	const execId = toolCallId ? `${toolCallId}:${token}` : toolCallId;
	try {
		if (token === "readArgs") {
			const path = str(args, "path");
			if (typeof args.limit === "number" && Math.floor(args.limit) <= 0) {
				return ompReadToSdkResult(path, { content: [{ type: "text", text: "" }], isError: false });
			}
			const readArgs: Record<string, unknown> = { path };
			const offset = optionalLine(args.offset);
			const limit = optionalLine(args.limit);
			if (offset !== undefined) readArgs.offset = offset;
			if (limit !== undefined) readArgs.limit = limit;
			return ompReadToSdkResult(path, await run("read", readArgs, execId));
		}
		if (token === "grepArgs") {
			const prepared = mapGrepArgs(args);
			if ("error" in prepared) return ompGrepToSdkResult(args, { content: [{ type: "text", text: prepared.error }], isError: true });
			return ompGrepToSdkResult(args, await run("grep", prepared.args, execId));
		}
		if (token === "shellArgs" || token === "shellStreamArgs") {
			return ompShellToSdkResult(args, await run("bash", mapShellArgs(args), execId));
		}
		const path = str(args, "path");
		const content = str(args, "fileText", "file_text");
		return ompWriteToSdkResult(path, await run("write", { path, content }, execId));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return ompToError(token, args, message);
	}
}

function ompToError(token: string, args: Record<string, unknown>, message: string): object {
	const path = str(args, "path");
	if (token === "readArgs") return { result: { case: "error", value: { path, error: message } } };
	if (token === "writeArgs") return { result: { case: "error", value: { path, error: message } } };
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

export const nativeReadHooked: boolean = (() => {
	try {
		const orig = readFileSync(BUNDLE, "utf8");
		if (!orig.includes(`globalThis.${HOOK}`)) {
			const patched = orig
				.replace("wG8(s,i.customTools);", `wG8(s,i.customTools);globalThis.${HOOK}?.(s);`)
				.replace("wG8(j,i.customTools),", `wG8(j,i.customTools),globalThis.${HOOK}?.(j),`);
			if (patched === orig) return false;
			writeFileSync(BUNDLE, patched);
		}
		installHook();
		return true;
	} catch {
		return false;
	}
})();

export function runWithNativeTools<T>(execute: NativeToolExecutor, fn: () => T): T {
	return nativeTools.run(execute, fn);
}

export function runWithNativeRead<T>(execute: NativeReadExecutor, fn: () => T): T {
	return runWithNativeTools(async (_name, args, toolCallId) => execute(args, toolCallId), fn);
}
