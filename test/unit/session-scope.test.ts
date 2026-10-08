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

test("ownerForRequest stays isolated from sessionId-only main owners", async () => {
	scopeTestUtils.reset();
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	registerCursorSessionScope({
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
	} as Pick<ExtensionAPI, "on">);
	const main = {
		cwd: "/tmp/main",
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => "side-key" },
	} as ExtensionContext;
	const request = await captureCursorRequestOwner(async () => {
		await handlers.get("before_provider_request")!({} as never, main);
	});
	const mainOwner = request.owner!;
	expect(mainOwner.persistent).toBe(true);
	expect(mainOwner.scopeKey).toBe(`${scopeTestUtils.EPHEMERAL_SESSION_SCOPE_PREFIX}side-key`);

	const side = ownerForRequest("side-key", "/tmp/aux");
	expect(side).not.toBe(mainOwner);
	expect(side.scopeKey).not.toBe(mainOwner.scopeKey);
	expect(side.persistent).toBe(false);
	expect(mainOwner.cwd).toBe("/tmp/main");
	expect(mainOwner.persistent).toBe(true);
	scopeTestUtils.reset();
});

test("two managers on one file do not share a writer, and shutdown hands the file back", async () => {
	scopeTestUtils.reset();
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	registerCursorSessionScope({
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
	} as Pick<ExtensionAPI, "on">);
	const file = "/tmp/shared.jsonl";
	const firstManager = {
		cwd: "/tmp/project",
		sessionManager: { getSessionFile: () => file, getSessionId: () => "sess" },
	} as ExtensionContext;
	const secondManager = {
		cwd: "/tmp/project",
		sessionManager: { getSessionFile: () => file, getSessionId: () => "sess" },
	} as ExtensionContext;
	const first = await captureCursorRequestOwner(async () => {
		await handlers.get("before_provider_request")!({} as never, firstManager);
	});
	const second = await captureCursorRequestOwner(async () => {
		await handlers.get("before_provider_request")!({} as never, secondManager);
	});
	expect(first.owner?.writer).toBe(true);
	expect(first.owner?.scopeKey).toBe(file);
	expect(second.owner?.writer).toBe(false);
	expect(second.owner?.persistent).toBe(false);
	expect(second.owner?.scopeKey).not.toBe(file);
	await handlers.get("session_shutdown")!({} as never, firstManager);
	const taken = await captureCursorRequestOwner(async () => {
		await handlers.get("before_provider_request")!({} as never, secondManager);
	});
	expect(taken.owner).toBe(second.owner);
	expect(taken.owner?.writer).toBe(true);
	expect(taken.owner?.scopeKey).toBe(file);
	expect(first.owner?.writer).toBe(false);
	scopeTestUtils.reset();
});

test("file rollover keeps the writer scope and a session id change starts a new one", async () => {
	scopeTestUtils.reset();
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	registerCursorSessionScope({
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
	} as Pick<ExtensionAPI, "on">);
	let file = "/tmp/original.jsonl";
	let sessionId = "sess-roll";
	const manager = {
		cwd: "/tmp/project",
		sessionManager: { getSessionFile: () => file, getSessionId: () => sessionId },
	} as ExtensionContext;
	const opened = await captureCursorRequestOwner(async () => {
		await handlers.get("before_provider_request")!({} as never, manager);
	});
	const owner = opened.owner!;
	file = "/tmp/rolled.jsonl";
	const rolled = await captureCursorRequestOwner(async () => {
		await handlers.get("before_provider_request")!({} as never, manager);
	});
	expect(rolled.owner).toBe(owner);
	expect(owner.scopeKey).toBe("/tmp/original.jsonl");
	expect(owner.sessionFile).toBe("/tmp/rolled.jsonl");
	expect(owner.writer).toBe(true);
	expect(owner.persistenceKey).toBe("session:sess-roll");
	const generation = owner.generation;
	sessionId = "sess-next";
	const replaced = await captureCursorRequestOwner(async () => {
		await handlers.get("before_provider_request")!({} as never, manager);
	});
	expect(replaced.owner).not.toBe(owner);
	expect(owner.generation).toBe(generation + 1);
	expect(replaced.owner?.writer).toBe(true);
	expect(replaced.owner?.scopeKey).toBe("/tmp/rolled.jsonl");
	expect(replaced.owner?.sessionId).toBe("sess-next");
	scopeTestUtils.reset();
});
