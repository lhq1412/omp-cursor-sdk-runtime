import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	__testUtils as scopeTestUtils,
	captureCursorRequestOwner,
	getCursorSessionCwd,
	getCursorSessionScopeKey,
	ownerForRequest,
	registerCursorSessionScope,
	withCursorSessionOwner,
} from "../../src/session-scope.ts";

test("request hooks retain their session across interleaved callbacks and routing-id aliases", async () => {
	scopeTestUtils.reset();
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	registerCursorSessionScope({
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
	} as Pick<ExtensionAPI, "on">);
	const parent = {
		cwd: "/tmp/parent",
		sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getSessionId: () => "shared-alias" },
	} as ExtensionContext;
	const child = {
		cwd: "/tmp/child",
		sessionManager: { getSessionFile: () => "/tmp/child.jsonl", getSessionId: () => "shared-alias" },
	} as ExtensionContext;
	const childEntered = Promise.withResolvers<void>();
	const [parentRequest, childRequest] = await Promise.all([
		captureCursorRequestOwner(async () => {
			await handlers.get("before_provider_request")!({} as never, parent);
			await childEntered.promise;
		}),
		captureCursorRequestOwner(async () => {
			await handlers.get("before_provider_request")!({} as never, child);
			childEntered.resolve();
		}),
	]);
	expect(parentRequest.owner).toBeDefined();
	expect(childRequest.owner).toBeDefined();
	await withCursorSessionOwner(parentRequest.owner!, async () => {
		await withCursorSessionOwner(childRequest.owner!, async () => {
			expect(getCursorSessionScopeKey()).toBe("/tmp/child.jsonl");
			expect(getCursorSessionCwd()).toBe("/tmp/child");
		});
		expect(getCursorSessionScopeKey()).toBe("/tmp/parent.jsonl");
		expect(getCursorSessionCwd()).toBe("/tmp/parent");
	});
	const firstTitle = ownerForRequest("shared-alias");
	const secondTitle = ownerForRequest("shared-alias");
	expect(firstTitle.scopeKey).not.toBe(secondTitle.scopeKey);
	expect(firstTitle.scopeKey).not.toBe(parentRequest.owner!.scopeKey);
	expect(firstTitle.persistent).toBe(false);
	scopeTestUtils.reset();
});
