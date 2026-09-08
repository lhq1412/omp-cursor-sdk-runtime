import { CURSOR_API_KEY_ENV_VAR } from "./constants.js";

const PLACEHOLDERS: Record<string, true> = {
	[CURSOR_API_KEY_ENV_VAR]: true,
	[`$${CURSOR_API_KEY_ENV_VAR}`]: true,
	[`\${${CURSOR_API_KEY_ENV_VAR}}`]: true,
};

export function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (PLACEHOLDERS[trimmed]) return process.env[CURSOR_API_KEY_ENV_VAR]?.trim() || undefined;
	return trimmed;
}

export function requireCursorApiKey(apiKey?: string): string {
	const resolved = resolveCursorApiKey(apiKey) ?? resolveCursorApiKey(process.env[CURSOR_API_KEY_ENV_VAR]);
	if (!resolved) {
		throw new Error(`A Cursor SDK API key is required (${CURSOR_API_KEY_ENV_VAR} or provider options)`);
	}
	return resolved;
}
