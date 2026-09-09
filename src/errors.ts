import { CURSOR_API_KEY_ENV_VAR } from "./constants.js";

/** Provider diagnostics only: never apply this to assistant content or tool results. */
export function sanitizeCursorProviderError(error: unknown, apiKey?: string): string {
	const parts: string[] = [];
	const seen = new Set<object>();
	let current = error;
	while (current !== null && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const record = current as Record<string, unknown>;
		if (typeof record.message === "string") parts.push(record.message);
		for (const field of ["name", "code", "status", "requestId", "request_id"] as const) {
			const value = record[field];
			if ((typeof value === "string" && value && value !== "Error") || typeof value === "number") {
				parts.push(`${field}=${value}`);
			}
		}
		current = record.cause;
	}
	if (typeof current === "string") parts.push(current);
	let message = parts.join("\n").trim() || "Cursor SDK request failed";
	for (const key of [apiKey?.trim(), process.env[CURSOR_API_KEY_ENV_VAR]?.trim()]) {
		if (!key) continue;
		for (const value of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) {
			message = message.split(value).join("<redacted>");
		}
	}
	message = message
		.replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>}]+/gi, "<redacted>")
		.replace(/(["']?\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n;}]+)/gi, "$1<redacted>")
		.replace(/(["']?\b(?:cookie|set-cookie)["']?\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n}]+)/gi, "$1<redacted>")
		.replace(/(["']?\b(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth|client[_-]?secret|password|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)/gi, "$1<redacted>")
		.replace(/([?&](?:[^=&#\s]*[_-])?(?:token|key|secret|signature|auth|authorization|credential)(?:[_-][^=&#\s]*)?=)(?:<redacted>|[^&#\s"'<>]*)/gi, "$1<redacted>")
		.replace(/\bcrsr_[A-Za-z0-9._-]+/g, "<redacted>");

	const detail = message.toLowerCase().replace(/[_-]/g, " ");
	const quota = /quota|usage limit|insufficient credits|billing/.test(detail);
	const rate = /rate.?limit|too many requests|status=429\b|tokens? per (?:minute|second|hour|day)|tokens?\/(?:min|sec)\b/.test(detail);
	if (quota || rate) {
		// OMP's generic overflow matcher otherwise treats token throughput limits as context limits.
		message = message.replace(/too many (?:input )?tokens/gi, "token throughput exceeded")
			.replace(/token limit exceeded/gi, "token throughput limit reached");
	}
	let category: string | undefined;
	if (quota) {
		category = "Quota exhausted";
	} else if (rate) {
		category = "Rate limited";
	} else if (/context (?:window|length).*(?:exceed|full|overflow|too (?:long|large))|(?:exceed|maximum).*context (?:window|length)|(?:prompt|input|conversation).*(?:too long|too large)|too many (?:input )?tokens/.test(detail)) {
		category = "Context window exceeded";
	} else if (/authentication|unauthenticated|unauthori[sz]ed|invalid api key|permission denied|status=(?:401|403)\b/.test(detail)) {
		category = "Authentication failed";
	} else if (/aborterror|cancelled|canceled|\baborted\b/.test(detail)) {
		category = "Cancelled";
	} else if (/resource exhausted/.test(detail)) {
		category = "Resource capacity exhausted";
	} else if (/network|fetch failed|econnreset|econnrefused|enotfound|etimedout|timed? ?out|unavailable|status=50[234]\b/.test(detail)) {
		category = "Network error";
	}
	return category && !message.startsWith(category) ? `${category}: ${message}` : message;
}
