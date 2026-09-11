import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getCursorSessionOwner, sessionEvents } from "./session-scope.js";
import { disposeRuntimeForScope, disposeRuntimeForShutdown, invalidateRuntime } from "./session-runtime.js";

export function registerCursorSessionLifecycle(pi: Pick<ExtensionAPI, "on">): void {
	const on = sessionEvents(pi);
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
}
