type ProcessWithReallyExit = NodeJS.Process & { reallyExit?: (code?: number) => void };

/**
 * Cursor SDK teardown can call `process.exit` / `process.reallyExit`.
 * `@cursor/sdk` loads `signal-exit`, which captures the current `reallyExit` at
 * import time. OMP's `withHostGuard` has already replaced that slot with a
 * function that throws ExtensionExitError — so a later `reallyExit(1)` on quit
 * becomes an unhandled rejection even after the guard is restored.
 *
 * Import this module before `@cursor/sdk` so signal-exit captures a swallow
 * instead of OMP's throwing guard. Scoped `withSdkExitSuppressed` still covers
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

export function wrapReallyExitForSdk(inner: (code?: number) => void): (code?: number) => void {
	return (code?: number) => {
		if (isSdkHostExitCode(code)) return;
		inner.call(process, code);
	};
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
	if (typeof proc.reallyExit !== "function") return;
	if (isNativeFunction(proc.reallyExit)) return;
	proc.reallyExit = wrapReallyExitForSdk(proc.reallyExit.bind(process)) as typeof proc.reallyExit;
}

function installScopedSwallow(): void {
	const proc = process as ProcessWithReallyExit;
	hostExit = process.exit.bind(process);
	hostReallyExit = proc.reallyExit?.bind(process);
	const swallow = ((code?: number) => {
		if (isSdkHostExitCode(code)) return undefined as never;
		if (!hostExit) throw new Error(`Cursor SDK attempted process.exit(${code})`);
		return hostExit(code);
	}) as typeof process.exit;
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
