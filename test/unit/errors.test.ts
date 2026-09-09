import { describe, expect, test } from "bun:test";
import { isContextOverflow } from "@oh-my-pi/pi-ai/error";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { sanitizeCursorProviderError } from "../../src/errors.ts";

function isOverflow(errorMessage: string): boolean {
	return isContextOverflow({ stopReason: "error", errorMessage } as AssistantMessage);
}

describe("Cursor provider diagnostics", () => {
	test("redacts credentials in thrown SDK errors without losing request diagnostics", () => {
		const key = "current/key+private";
		const error = Object.assign(new Error(`Invalid API key ${key}; encoded=${encodeURIComponent(key)}; Authorization: Bearer header-secret; proxy-authorization='Basic proxy-secret'; {"x-api-key":"json-secret"}; https://cursor.com/send?access_token=query-secret&signature=signed-secret&requestId=request-42; crsr_other-secret`), {
			code: "unauthenticated",
			status: 401,
			requestId: "request-42",
			cause: new Error("refresh_token=refresh-secret"),
		});
		const message = sanitizeCursorProviderError(error, key);
		for (const secret of [key, encodeURIComponent(key), "header-secret", "proxy-secret", "json-secret", "query-secret", "signed-secret", "other-secret", "refresh-secret"]) {
			expect(message).not.toContain(secret);
		}
		expect(message).toContain("Authentication failed");
		expect(message).toContain("unauthenticated");
		expect(message).toContain("requestId=request-42");
		expect(sanitizeCursorProviderError(message, key)).toBe(message);
	});

	test("only explicit context exhaustion reaches OMP context recovery", () => {
		for (const error of [
			{ code: "context_length_exceeded", message: "request rejected" },
			{ code: "resource_exhausted", message: "maximum context length exceeded" },
			new Error("Context window exceeded: current input and system instructions exceed the model input budget (conservative estimate)"),
		]) {
			expect(isOverflow(sanitizeCursorProviderError(error))).toBe(true);
		}
		for (const error of [
			{ code: "resource_exhausted", message: "request rejected" },
			{ code: "resource_exhausted", message: "monthly quota exceeded" },
			{ code: "resource_exhausted", message: "rate limit exceeded" },
		]) {
			expect(isOverflow(sanitizeCursorProviderError(error))).toBe(false);
		}
		expect(sanitizeCursorProviderError({ code: "resource_exhausted", message: "monthly quota exceeded" })).toContain("Quota exhausted");
		expect(sanitizeCursorProviderError({ code: "resource_exhausted", message: "rate limit exceeded" })).toContain("Rate limited");
	});

	test("redacts authorization schemes other than bearer", () => {
		const message = sanitizeCursorProviderError('Authorization: Digest username="private-user", response="private-response"\nrequestId=req-digest');
		expect(message).not.toContain("private-user");
		expect(message).not.toContain("private-response");
		expect(message).toContain("req-digest");
	});

	test("redacts every cookie value while preserving separate SDK diagnostics", () => {
		const message = sanitizeCursorProviderError({
			message: "Cookie: theme=dark; session=other-secret; csrf=csrf-secret\nSet-Cookie: session=returned-secret; HttpOnly",
			code: "unauthenticated",
			requestId: "request-cookie",
		});
		for (const secret of ["other-secret", "csrf-secret", "returned-secret"]) {
			expect(message).not.toContain(secret);
		}
		expect(message).toContain("unauthenticated");
		expect(message).toContain("request-cookie");
	});

	test("token throughput exhaustion never triggers OMP context recovery", () => {
		for (const message of [
			"rate limit exceeded: too many tokens per minute",
			"resource_exhausted: token limit exceeded; tokens per minute exceeded",
			"quota exceeded: too many tokens",
		]) {
			const diagnostic = sanitizeCursorProviderError({ message, requestId: "request-rate" });
			expect(isOverflow(diagnostic)).toBe(false);
			expect(diagnostic).toContain("request-rate");
			expect(diagnostic).toMatch(/^(?:Rate limited|Quota exhausted)/);
		}
	});

	test("retains network and cancellation categories and safely handles cyclic causes", () => {
		const network = Object.assign(new Error("fetch failed"), { cause: undefined as unknown, code: "ECONNRESET" });
		network.cause = network;
		expect(sanitizeCursorProviderError(network)).toContain("Network error");
		expect(sanitizeCursorProviderError({ name: "AbortError", message: "operation stopped" })).toContain("Cancelled");
	});
});
