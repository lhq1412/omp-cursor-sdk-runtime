import { describe, expect, test } from "bun:test";
import {
	__testUtils as scopeTestUtils,
	getCursorSessionCwd,
	getCursorSessionScopeKey,
	registerCursorSessionScope,
} from "../../src/session-scope.ts";

describe("session scope", () => {
	test("falls back to an anonymous key before session_start", () => {
		scopeTestUtils.reset();
		expect(getCursorSessionScopeKey()).toBe(scopeTestUtils.ANONYMOUS_SESSION_SCOPE_KEY);
		expect(getCursorSessionCwd()).toBe(process.cwd());
	});

	test("uses the OMP session file as the scope key", async () => {
		scopeTestUtils.reset();
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		};
		registerCursorSessionScope(pi as never);
		await handlers.get("session_start")?.[0]?.(
			{ type: "session_start" },
			{
				cwd: "/tmp/project",
				sessionManager: {
					getSessionFile: () => "/tmp/project/session.jsonl",
					getSessionId: () => "sess-1",
				},
			},
		);
		expect(getCursorSessionScopeKey()).toBe("/tmp/project/session.jsonl");
		expect(getCursorSessionCwd()).toBe("/tmp/project");
	});
});
