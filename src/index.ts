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

export default async function (pi: ExtensionAPI): Promise<void> {
	registerCursorSessionScope(pi);
	registerCursorSessionResume(pi);
	registerCursorSessionLifecycle(pi);
	registerHostToolCatalog(pi);
	registerModelControls(pi);
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
			try {
				const resolved = resolveCursorApiKey(apiKey);
				if (!resolved) {
					recordDynamicModelFetch(false, "No Cursor SDK API key configured; using fallback models.");
					return fallbackModels();
				}
				const models = await fetchCursorModels(resolved);
				recordDynamicModelFetch(true);
				return models;
			} catch (error) {
				recordDynamicModelFetch(false, error instanceof Error ? error.message : String(error));
				throw error;
			}
		},
	});
}
