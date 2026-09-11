type ProcessWithReallyExit = NodeJS.Process & { reallyExit?: (code?: number) => void };

const NATIVE_PROCESS_EXIT = Symbol.for("omp.postmortem.nativeProcessExit");

/**
 * Cursor SDK teardown can call `process.exit` / `process.reallyExit`.
 * `@cursor/sdk` loads `signal-exit`, which captures the current `reallyExit` at
 * import time. OMP's `withHostGuard` has already replaced that slot with a
 * function that throws ExtensionExitError — so a later `reallyExit(1)` on quit
 * becomes an unhandled rejection even after the guard is restored.
 *
 * Import this module before `@cursor/sdk` so signal-exit captures a swallow
 * instead of OMP's throwing guard. Copy OMP's native-exit stamp onto that
 * swallow so host SIGINT (`reallyExit(130)`) during the guard window still
 * unwraps to native exit. Scoped `withSdkExitSuppressed` still covers
 * direct `process.exit` during create/send/dispose.
 *
 * Nested/overlapping calls share one installed swallow and restore the host
 * functions only when the last call exits. Async save/restore of the global
 * slots is not safe.
 */
export function isSdkHostExitCode(code?: number | string): boolean {
	if (code === undefined || code === 0 || code === 1) return true;
	if (typeof code === "string" && (code === "" || code === "0" || code === "1")) return true;
	return false;
}

function stampNativeExit(from: object, to: object): void {
	const native = Reflect.get(from, NATIVE_PROCESS_EXIT);
	if (typeof native === "function") Reflect.set(to, NATIVE_PROCESS_EXIT, native);
}

export function wrapReallyExitForSdk(inner: (code?: number) => void): (code?: number) => void {
	const wrapped = (code?: number) => {
		if (isSdkHostExitCode(code)) return;
		inner.call(process, code);
	};
	stampNativeExit(inner, wrapped);
	return wrapped;
}

function isNativeFunction(fn: Function): boolean {
	return Function.prototype.toString.call(fn).includes("[native code]");
}

let installed = false;
let suppressDepth = 0;
let hostExit: typeof process.exit | undefined;
let hostReallyExit: ((code?: number) => void) | undefined;

export function installSdkExitGuard(): void {
	if (installed) return;
	installed = true;
	const proc = process as ProcessWithReallyExit;
	const original = proc.reallyExit;
	if (typeof original !== "function") return;
	if (isNativeFunction(original)) return;
	proc.reallyExit = wrapReallyExitForSdk(original) as typeof proc.reallyExit;
}

function installScopedSwallow(): void {
	const proc = process as ProcessWithReallyExit;
	hostExit = process.exit;
	hostReallyExit = proc.reallyExit;
	const swallow = ((code?: number) => {
		if (isSdkHostExitCode(code)) return undefined as never;
		if (!hostExit) throw new Error(`Cursor SDK attempted process.exit(${code})`);
		return hostExit.call(process, code);
	}) as typeof process.exit;
	stampNativeExit(hostExit, swallow);
	process.exit = swallow;
	if (typeof hostReallyExit === "function") {
		proc.reallyExit = wrapReallyExitForSdk(hostReallyExit) as typeof proc.reallyExit;
	}
}

function restoreHostExit(): void {
	const proc = process as ProcessWithReallyExit;
	if (hostExit) process.exit = hostExit;
	if (hostReallyExit) proc.reallyExit = hostReallyExit;
	hostExit = undefined;
	hostReallyExit = undefined;
}

export async function withSdkExitSuppressed<T>(fn: () => Promise<T>): Promise<T> {
	if (suppressDepth === 0) installScopedSwallow();
	suppressDepth += 1;
	try {
		return await fn();
	} finally {
		suppressDepth -= 1;
		if (suppressDepth === 0) restoreHostExit();
	}
}

installSdkExitGuard();
