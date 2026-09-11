import "./sdk-exit-guard.js";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_API_KEY_ENV_VAR, CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "./constants.js";
import { fallbackModels, fetchCursorModels } from "./catalog.js";
import { streamCursorRuntime } from "./provider.js";
import { resolveCursorApiKey } from "./auth.js";
import { registerCursorSessionScope } from "./session-scope.js";
import { registerCursorSessionResume } from "./session-resume.js";
import { registerCursorSessionLifecycle } from "./session-lifecycle.js";
import { registerHostToolCatalog } from "./tool-catalog.js";
import { recordDynamicModelFetch, registerModelControls } from "./model-controls.js";
import { sanitizeCursorProviderError } from "./errors.js";
import { registerCursorToolCallIds } from "./context.js";
import { registerCursorWebSearchTool } from "./web-search-tool.js";
import { registerCursorUsage } from "./usage-command.js";

export default async function (pi: ExtensionAPI): Promise<void> {
	registerCursorSessionResume(pi);
	registerCursorSessionLifecycle(pi);
	registerHostToolCatalog(pi);
	registerCursorWebSearchTool(pi);
	registerModelControls(pi);
	registerCursorUsage(pi);
	registerCursorToolCallIds(pi);
	registerCursorSessionScope(pi);
	pi.registerProvider(CURSOR_SDK_PROVIDER_ID, {
		baseUrl: "https://cursor.com",
		api: CURSOR_SDK_API,
		apiKey: CURSOR_API_KEY_ENV_VAR,
		oauth: {
			name: "Cursor SDK API key",
			login: async (callbacks) => {
				const apiKey = (
					await callbacks.onPrompt({
						message: "Paste a Cursor SDK API key from Cursor Dashboard → API Keys",
						placeholder: "crsr_...",
					})
				).trim();
				if (!apiKey) throw new Error("A Cursor SDK API key is required.");
				return apiKey;
			},
		},
		streamSimple: streamCursorRuntime,
		fetchDynamicModels: async (apiKey) => {
			let resolved: string | undefined;
			try {
				resolved = resolveCursorApiKey(apiKey);
				if (!resolved) {
					recordDynamicModelFetch(false, "No Cursor SDK API key configured; using fallback models.");
					return fallbackModels();
				}
				const models = await fetchCursorModels(resolved);
				recordDynamicModelFetch(true);
				return models;
			} catch (error) {
				const message = sanitizeCursorProviderError(error, resolved);
				recordDynamicModelFetch(false, message);
				throw new Error(message);
			}
		},
	});
}
