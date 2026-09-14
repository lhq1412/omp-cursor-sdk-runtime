import { describe, expect, test } from "bun:test";
import { normalizeToolCallId } from "@oh-my-pi/pi-ai/utils";
import { nativeToolCallId, projectSdkToolCallId } from "../../src/tool-call-id.ts";

const PORTABLE = /^[A-Za-z0-9_-]+$/;

function longId(suffix: string): string {
	return `${"x".repeat(64)}${suffix}`;
}

describe("projectSdkToolCallId", () => {
	test("keeps already-portable IDs", () => {
		for (const id of ["call_abc123", "read-42", "a".repeat(64)]) {
			expect(projectSdkToolCallId(id)).toBe(id);
		}
	});

	test("hashes 87-char IDs to a portable 64-char value", () => {
		const raw = longId("y".repeat(23));
		expect(raw.length).toBe(87);
		const projected = projectSdkToolCallId(raw);
		expect(projected.length).toBe(64);
		expect(projected).toMatch(PORTABLE);
		expect(normalizeToolCallId(projected)).toBe(projected);
		expect(projected).not.toBe(raw);
		expect(projected).not.toBe(normalizeToolCallId(raw));
	});

	test("is deterministic", () => {
		const raw = longId("same-tail");
		expect(projectSdkToolCallId(raw)).toBe(projectSdkToolCallId(raw));
	});

	test("does not collide when only the truncated tail differs", () => {
		const a = longId("A");
		const b = longId("B");
		expect(normalizeToolCallId(a)).toBe(normalizeToolCallId(b));
		const canonicalA = projectSdkToolCallId(a);
		const canonicalB = projectSdkToolCallId(b);
		expect(canonicalA).not.toBe(canonicalB);
		expect(canonicalA).toMatch(PORTABLE);
		expect(canonicalB).toMatch(PORTABLE);
	});

	test("hashes IDs with illegal characters", () => {
		const raw = "call|abc/def:xyz";
		const projected = projectSdkToolCallId(raw);
		expect(projected).not.toBe(raw);
		expect(projected).toMatch(PORTABLE);
		expect(projected.length).toBeLessThanOrEqual(64);
		expect(normalizeToolCallId(projected)).toBe(projected);
	});
});

describe("nativeToolCallId", () => {
	test("is a distinct mapping from SDK → OMP projection", () => {
		const id = "call_abc123";
		expect(nativeToolCallId(id)).not.toBe(projectSdkToolCallId(id));
		expect(nativeToolCallId(id)).toBe(nativeToolCallId(id));
		expect(nativeToolCallId(id)).toMatch(/^[0-9a-f]{64}$/);
	});
});
