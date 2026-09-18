import type { ExtensionAPI, ExtensionContext, SessionCompactEvent } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_SDK_PROVIDER_ID } from "./constants.js";
import {
	clearCoordinator,
	commitOwnMaterialization,
	noteMainSessionStop,
	onAgentEnd,
	onSessionBeforeCompact,
} from "./native-summary-compaction.js";
import { resolveRegistryApiKey } from "./model-controls.js";
import { getCursorSessionOwner, sessionEvents } from "./session-scope.js";
import { disposeRuntimeForScope, disposeRuntimeForShutdown, invalidateRuntime, warmLocalExecutor } from "./session-runtime.js";

export function registerCursorSessionLifecycle(pi: Pick<ExtensionAPI, "on">): void {
	const on = sessionEvents(pi);
	const autoCompacting = new Set<string>();
	const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
	const closeScope = async (_event: unknown, ctx: ExtensionContext) => {
		clearCoordinator(sessionId(ctx), ctx);
		getCursorSessionOwner().generation++;
		await disposeRuntimeForScope();
	};
	on("session_start", async (_event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== CURSOR_SDK_PROVIDER_ID) return;
		const apiKey = await resolveRegistryApiKey(ctx).catch(() => undefined);
		if (apiKey) warmLocalExecutor(ctx.cwd, apiKey, model.id);
	});
	on("session_shutdown", async (_event, ctx) => {
		clearCoordinator(sessionId(ctx), ctx);
		getCursorSessionOwner().generation++;
		await disposeRuntimeForShutdown();
	});
	on("session_compact", (event, ctx) => {
		if (commitOwnMaterialization(event as SessionCompactEvent, ctx)) return;
		clearCoordinator(sessionId(ctx), ctx);
		getCursorSessionOwner().generation++;
		invalidateRuntime("session_compact");
	});
	on("session_before_tree", (_event, ctx) => {
		clearCoordinator(sessionId(ctx), ctx);
		getCursorSessionOwner().generation++;
		invalidateRuntime("session_before_tree");
	});
	on("session_before_switch", closeScope);
	on("session_before_branch", closeScope);
	on("session_tree", closeScope);
	on("session_stop", (_event, ctx) => noteMainSessionStop(sessionId(ctx)));
	on("agent_end", (event, ctx) => {
		onAgentEnd(event, ctx);
	});
	// ponytail: session_before_compact registration disables OMP speculative compaction for every provider.
	on("auto_compaction_start", (_event, ctx) => {
		if (ctx.model?.provider !== CURSOR_SDK_PROVIDER_ID) return;
		const id = sessionId(ctx);
		if (id) autoCompacting.add(id);
	});
	on("session_before_compact", (event, ctx) => {
		const own = onSessionBeforeCompact(event, ctx);
		if (own) return own;
		const id = sessionId(ctx);
		if (id && ctx.model?.provider === CURSOR_SDK_PROVIDER_ID && autoCompacting.has(id)) return { cancel: true };
	});
	on("auto_compaction_end", (_event, ctx) => {
		const id = sessionId(ctx);
		if (id) autoCompacting.delete(id);
	});
}
