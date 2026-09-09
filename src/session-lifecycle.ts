import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { onCursorSessionScopeKeyChange } from "./session-scope.js";
import { disposeRuntimeForScope, disposeRuntimeForShutdown, invalidateRuntime } from "./session-runtime.js";

export function registerCursorSessionLifecycle(pi: Pick<ExtensionAPI, "on">): void {
	onCursorSessionScopeKeyChange(async (previousScopeKey) => {
		await disposeRuntimeForScope(previousScopeKey);
	});
	pi.on("session_shutdown", async () => {
		await disposeRuntimeForShutdown();
	});
	pi.on("session_compact", () => {
		invalidateRuntime("session_compact");
	});
	pi.on("session_before_tree", () => {
		invalidateRuntime("session_before_tree");
	});
	pi.on("session_tree", async () => {
		await disposeRuntimeForScope();
	});
}
