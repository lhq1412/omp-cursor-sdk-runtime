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

export default async function (pi: ExtensionAPI): Promise<void> {
	registerCursorSessionScope(pi);
	registerCursorSessionResume(pi);
	registerCursorSessionLifecycle(pi);
	registerHostToolCatalog(pi);
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
			const resolved = resolveCursorApiKey(apiKey);
			if (!resolved) return fallbackModels();
			return fetchCursorModels(resolved);
		},
	});
}
