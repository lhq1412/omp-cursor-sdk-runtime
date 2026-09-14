import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_SDK_PROVIDER_ID } from "./constants.js";
import { getCursorSessionOwner, sessionEvents } from "./session-scope.js";
import { disposeRuntimeForScope, disposeRuntimeForShutdown, invalidateRuntime } from "./session-runtime.js";

export function registerCursorSessionLifecycle(pi: Pick<ExtensionAPI, "on">): void {
	const on = sessionEvents(pi);
	const autoCompacting = new Set<string>();
	const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
	const closeScope = async () => {
		getCursorSessionOwner().generation++;
		await disposeRuntimeForScope();
	};
	on("session_shutdown", async () => {
		getCursorSessionOwner().generation++;
		await disposeRuntimeForShutdown();
	});
	on("session_compact", () => {
		getCursorSessionOwner().generation++;
		invalidateRuntime("session_compact");
	});
	on("session_before_tree", () => {
		getCursorSessionOwner().generation++;
		invalidateRuntime("session_before_tree");
	});
	on("session_before_switch", closeScope);
	on("session_before_branch", closeScope);
	on("session_tree", closeScope);
	// ponytail: session_before_compact registration disables OMP speculative compaction for every provider.
	on("auto_compaction_start", (_event, ctx) => {
		if (ctx.model?.provider !== CURSOR_SDK_PROVIDER_ID) return;
		const id = sessionId(ctx);
		if (id) autoCompacting.add(id);
	});
	on("session_before_compact", (_event, ctx) => {
		const id = sessionId(ctx);
		if (id && ctx.model?.provider === CURSOR_SDK_PROVIDER_ID && autoCompacting.has(id)) return { cancel: true };
	});
	on("auto_compaction_end", (_event, ctx) => {
		const id = sessionId(ctx);
		if (id) autoCompacting.delete(id);
	});
}
