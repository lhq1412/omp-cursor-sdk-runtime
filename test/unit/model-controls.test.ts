import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_API_KEY_ENV_VAR, CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { __testUtils as catalogTestUtils } from "../../src/catalog.ts";
import {
	__testUtils as controlsTestUtils,
	getFastMode,
	recordDynamicModelFetch,
	registerModelControls,
} from "../../src/model-controls.ts";

type SessionEntry = {
	type: string;
	id?: string;
	parentId?: string | null;
	customType?: string;
	data?: unknown;
};

interface HostOptions {
	model?: { id: string; provider: string } | undefined;
	flags?: Record<string, boolean | string>;
	branch?: SessionEntry[];
	refreshProvider?: (providerId: string, strategy?: string) => Promise<void>;
	getApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
	appendError?: Error;
}

function createHost(options: HostOptions = {}) {
	const flags: Record<string, boolean | string | undefined> = { ...options.flags };
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContextLike) => unknown>>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const appended: Array<{ type: string; data: unknown }> = [];
	const refreshCalls: Array<{ providerId: string; strategy?: string; thisValue: unknown }> = [];
	let branch = options.branch ?? [];
	let model = options.model ?? { id: "composer-2.5", provider: CURSOR_SDK_PROVIDER_ID };

	const modelRegistry = {
		async refreshProvider(this: unknown, providerId: string, strategy?: string): Promise<void> {
			refreshCalls.push({ providerId, strategy, thisValue: this });
			await options.refreshProvider?.call(this, providerId, strategy);
		},
		async getApiKeyForProvider(providerId: string) {
			return options.getApiKeyForProvider?.(providerId);
		},
	};

	type ExtensionContextLike = {
		model: typeof model;
		hasUI: boolean;
		ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
		sessionManager: { getBranch: () => SessionEntry[] };
		modelRegistry: typeof modelRegistry;
	};

	const ctx: ExtensionContextLike = {
		model,
		hasUI: true,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
		sessionManager: {
			getBranch: () => branch,
		},
		modelRegistry,
	};

	const pi = {
		registerFlag(name: string, flag: { type: "boolean" | "string"; default?: boolean | string }) {
			if (!(name in flags)) flags[name] = flag.default ?? (flag.type === "boolean" ? false : "");
		},
		getFlag(this: unknown, name: string) {
			if (this !== pi) throw new Error("getFlag lost this");
			return flags[name];
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		appendEntry(this: unknown, customType: string, data?: unknown) {
			if (this !== pi) throw new Error("appendEntry lost this");
			if (options.appendError) throw options.appendError;
			appended.push({ type: customType, data });
			branch = [
				...branch,
				{ type: "custom", customType, data },
			];
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContextLike) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};

	return {
		pi: pi as Pick<ExtensionAPI, "registerFlag" | "registerCommand" | "getFlag" | "appendEntry" | "on">,
		ctx: ctx as unknown as ExtensionCommandContext,
		commands,
		handlers,
		notifications,
		appended,
		refreshCalls,
		setFlags(next: Record<string, boolean | string>) {
			Object.assign(flags, next);
		},
		setModel(next: { id: string; provider: string } | undefined) {
			model = next as typeof model;
			ctx.model = model;
		},
		setBranch(next: SessionEntry[]) {
			branch = next;
		},
		async emit(event: string) {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
		},
		async run(name: string, args = "") {
			const handler = commands.get(name);
			if (!handler) throw new Error(`missing command ${name}`);
			await handler(args, ctx as unknown as ExtensionCommandContext);
		},
	};
}

function metadata(id: string, overrides: { baseModelId?: string; supportsFast?: boolean } = {}) {
	return {
		baseModelId: overrides.baseModelId ?? id.replace(/^cursor-sdk\//, ""),
		supportsFast: overrides.supportsFast ?? true,
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function deferCatalog(...modelIds: string[]) {
	controlsTestUtils.reset();
	const started = deferred();
	const gate = deferred();
	const calls: string[] = [];
	catalogTestUtils.setListModels(async (apiKey) => {
		calls.push(apiKey);
		started.resolve();
		await gate.promise;
		return modelIds.map((id) => ({
			id,
			displayName: id,
			parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
		}));
	});
	return { started: started.promise, release: gate.resolve, calls };
}

function fastBranch(modelId: string, fast: boolean): SessionEntry[] {
	return [{
		type: "custom",
		customType: controlsTestUtils.FAST_ENTRY_TYPE,
		data: { modelId, fast },
	}];
}

describe("model controls", () => {
	let originalApiKey: string | undefined;

	beforeEach(() => {
		originalApiKey = process.env[CURSOR_API_KEY_ENV_VAR];
		delete process.env[CURSOR_API_KEY_ENV_VAR];
		controlsTestUtils.reset();
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setListModels(async () => {
			throw new Error("No live catalog configured for this test");
		});
		controlsTestUtils.setMetadataLookup((id) => {
			const bare = id.replace(/^cursor-sdk\//, "");
			if (bare === "composer-2.5") return metadata(bare);
			if (bare === "no-fast") return metadata(bare, { supportsFast: false });
			return undefined;
		});
	});

	afterEach(() => {
		if (originalApiKey === undefined) delete process.env[CURSOR_API_KEY_ENV_VAR];
		else process.env[CURSOR_API_KEY_ENV_VAR] = originalApiKey;
		controlsTestUtils.reset();
		catalogTestUtils.resetCatalog();
	});

	test("getFastMode defaults false and honors --cursor-no-fast over --cursor-fast", () => {
		const host = createHost({ flags: { "cursor-fast": true, "cursor-no-fast": true } });
		registerModelControls(host.pi);
		expect(getFastMode("composer-2.5")).toBe(false);
		host.setFlags({ "cursor-no-fast": false, "cursor-fast": true });
		expect(getFastMode("composer-2.5")).toBe(true);
		host.setFlags({ "cursor-fast": false });
		expect(getFastMode("composer-2.5")).toBe(false);
	});

	test("/cursor-fast on persists per canonical model and status reports the effective setting", async () => {
		const host = createHost();
		registerModelControls(host.pi);
		await host.run("cursor-fast", "on");
		expect(getFastMode("composer-2.5")).toBe(true);
		expect(host.appended).toEqual([
			{ type: controlsTestUtils.FAST_ENTRY_TYPE, data: { modelId: "composer-2.5", fast: true } },
		]);
		await host.run("cursor-fast", "status");
		expect(host.notifications.map((item) => item.type)).toEqual(["info", "info"]);
		expect(getFastMode("composer-2.5")).toBe(true);
		expect(host.appended).toHaveLength(1);
	});

	test("persists explicit fast against metadata.baseModelId for @context rows", async () => {
		controlsTestUtils.setMetadataLookup((id) => {
			if (id === "composer-2.5@1m" || id === "composer-2.5") return metadata("composer-2.5");
			return undefined;
		});
		const host = createHost({ model: { id: "composer-2.5@1m", provider: CURSOR_SDK_PROVIDER_ID } });
		registerModelControls(host.pi);
		await host.run("cursor-fast", "on");
		expect(getFastMode("composer-2.5")).toBe(true);
		expect(host.appended).toEqual([
			{ type: controlsTestUtils.FAST_ENTRY_TYPE, data: { modelId: "composer-2.5", fast: true } },
		]);
	});

	test("/cursor-fast off and empty status round-trip session state", async () => {
		const host = createHost();
		registerModelControls(host.pi);
		await host.run("cursor-fast", "on");
		await host.run("cursor-fast", "off");
		expect(getFastMode("composer-2.5")).toBe(false);
		await host.run("cursor-fast", "");
		expect(host.notifications.at(-1)?.type).toBe("info");
		expect(host.appended.map((entry) => entry.data)).toEqual([
			{ modelId: "composer-2.5", fast: true },
			{ modelId: "composer-2.5", fast: false },
		]);
	});

	test("rejects invalid args, wrong provider, and unsupported models", async () => {
		const host = createHost();
		registerModelControls(host.pi);
		await host.run("cursor-fast", "maybe");
		host.setModel({ id: "claude-sonnet-4", provider: "anthropic" });
		await host.run("cursor-fast", "on");
		host.setModel({ id: "no-fast", provider: CURSOR_SDK_PROVIDER_ID });
		await host.run("cursor-fast", "on");
		host.setModel(undefined);
		await host.run("cursor-fast", "status");
		expect(getFastMode("composer-2.5")).toBe(false);
		expect(host.appended).toEqual([]);
		expect(host.notifications.map((item) => item.type)).toEqual(["error", "error", "error", "error"]);
	});

	test("forced CLI flags block on/off but status still reports the effective setting", async () => {
		const host = createHost({ flags: { "cursor-no-fast": true } });
		registerModelControls(host.pi);
		await host.run("cursor-fast", "on");
		expect(host.appended).toEqual([]);
		await host.run("cursor-fast", "status");
		expect(host.notifications.map((item) => item.type)).toEqual(["error", "info"]);
		expect(getFastMode("composer-2.5")).toBe(false);
	});

	test("session start/switch/tree fold custom entries and do not leak across sessions", async () => {
		const host = createHost();
		registerModelControls(host.pi);
		await host.run("cursor-fast", "on");
		expect(getFastMode("composer-2.5")).toBe(true);

		host.setBranch([]);
		await host.emit("session_switch");
		expect(getFastMode("composer-2.5")).toBe(false);

		host.setBranch([
			{
				type: "custom",
				customType: controlsTestUtils.FAST_ENTRY_TYPE,
				data: { modelId: "composer-2.5", fast: true },
			},
		]);
		await host.emit("session_start");
		expect(getFastMode("composer-2.5")).toBe(true);

		host.setBranch([
			{
				type: "custom",
				customType: controlsTestUtils.FAST_ENTRY_TYPE,
				data: { modelId: "composer-2.5", fast: false },
			},
		]);
		await host.emit("session_tree");
		expect(getFastMode("composer-2.5")).toBe(false);
	});

	test("appendEntry failures roll back in-memory state and preserve method this", async () => {
		const host = createHost({ appendError: new Error("journal full") });
		registerModelControls(host.pi);
		await host.run("cursor-fast", "on");
		expect(getFastMode("composer-2.5")).toBe(false);
		expect(host.appended).toEqual([]);
		expect(host.notifications.at(-1)?.type).toBe("error");
	});

	test("/cursor-refresh-models without a key fails without refreshing", async () => {
		const host = createHost({
			refreshProvider: async () => recordDynamicModelFetch(true),
		});
		registerModelControls(host.pi);
		await host.run("cursor-refresh-models");
		expect(host.refreshCalls).toEqual([]);
		expect(host.notifications.map((item) => item.type)).toEqual(["error"]);
	});

	test("/cursor-refresh-models requires a newly recorded successful live fetch", async () => {
		let outcome: boolean | undefined = true;
		const host = createHost({
			model: { id: "other-model", provider: "other-provider" },
			getApiKeyForProvider: async (providerId) =>
				providerId === CURSOR_SDK_PROVIDER_ID ? "crsr_test" : undefined,
			refreshProvider: async () => {
				if (outcome !== undefined) recordDynamicModelFetch(outcome, "catalog unavailable");
			},
		});
		registerModelControls(host.pi);
		await host.run("cursor-refresh-models");
		expect(host.refreshCalls).toEqual([
			{ providerId: CURSOR_SDK_PROVIDER_ID, strategy: "online", thisValue: host.ctx.modelRegistry },
		]);
		expect(host.notifications.map((item) => item.type)).toEqual(["info"]);

		outcome = undefined;
		await host.run("cursor-refresh-models");
		outcome = false;
		await host.run("cursor-refresh-models");
		expect(host.refreshCalls).toHaveLength(3);
		expect(host.notifications.map((item) => item.type)).toEqual(["info", "error", "error"]);
	});

	test("/cursor-refresh-models falls back to the environment key", async () => {
		process.env[CURSOR_API_KEY_ENV_VAR] = "crsr_env_test";
		const host = createHost({
			refreshProvider: async () => recordDynamicModelFetch(true),
		});
		registerModelControls(host.pi);
		await host.run("cursor-refresh-models");
		expect(host.refreshCalls).toHaveLength(1);
		expect(host.notifications.map((item) => item.type)).toEqual(["info"]);
	});

	test("/cursor-refresh-models reports thrown refresh failures", async () => {
		const host = createHost({
			getApiKeyForProvider: async () => "crsr_test",
			refreshProvider: async () => {
				throw new Error("catalog unavailable");
			},
		});
		registerModelControls(host.pi);
		await host.run("cursor-refresh-models");
		expect(host.refreshCalls).toHaveLength(1);
		expect(host.notifications.map((item) => item.type)).toEqual(["error"]);
	});

	test("seeds composer fallback metadata so /cursor-fast works without credentials", async () => {
		controlsTestUtils.reset();
		const host = createHost();
		registerModelControls(host.pi);
		await host.run("cursor-fast", "on");
		expect(getFastMode("composer-2.5")).toBe(true);
		expect(host.appended).toEqual([
			{ type: controlsTestUtils.FAST_ENTRY_TYPE, data: { modelId: "composer-2.5", fast: true } },
		]);
		expect(host.notifications.every((item) => item.type !== "error")).toBe(true);
	});

	test("failed hydration cannot enable fast for an unknown cached model", async () => {
		controlsTestUtils.reset();
		catalogTestUtils.setListModels(async () => {
			throw new Error("live catalog unavailable");
		});
		const host = createHost({
			model: { id: "cached-from-sqlite", provider: CURSOR_SDK_PROVIDER_ID },
			getApiKeyForProvider: async () => "crsr_test",
		});
		registerModelControls(host.pi);
		await host.run("cursor-fast", "on");
		expect(host.notifications.map((item) => item.type)).toEqual(["error"]);
		expect(getFastMode("cached-from-sqlite")).toBe(false);
		expect(host.appended).toEqual([]);
	});

	test("fetched fast capabilities remain isolated between credentials", async () => {
		controlsTestUtils.reset();
		catalogTestUtils.setListModels(async (apiKey) => [{
			id: "acct-model",
			displayName: "Account model",
			parameters: apiKey === "crsr_fast"
				? [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }]
				: [],
		}]);
		let apiKey = "crsr_fast";
		const host = createHost({
			model: { id: "acct-model", provider: CURSOR_SDK_PROVIDER_ID },
			getApiKeyForProvider: async () => apiKey,
		});
		registerModelControls(host.pi);
		await host.run("cursor-fast", "on");
		expect(getFastMode("acct-model")).toBe(true);

		host.setBranch([]);
		await host.emit("session_switch");
		apiKey = "crsr_standard";
		await host.run("cursor-fast", "on");
		expect(getFastMode("acct-model")).toBe(false);
		expect(host.appended).toEqual([
			{ type: controlsTestUtils.FAST_ENTRY_TYPE, data: { modelId: "acct-model", fast: true } },
		]);
		expect(host.notifications.map((item) => item.type)).toEqual(["info", "error"]);

		apiKey = "crsr_fast";
		await host.run("cursor-fast", "on");
		expect(getFastMode("acct-model")).toBe(true);
		expect(host.notifications.at(-1)?.type).toBe("info");
	});

	test.each(["on", "off"] as const)("pending %s cannot change the destination session", async (action) => {
		const catalog = deferCatalog("cached-model");
		const host = createHost({
			model: { id: "cached-model", provider: CURSOR_SDK_PROVIDER_ID },
			getApiKeyForProvider: async () => "crsr_test",
		});
		registerModelControls(host.pi);
		await host.emit("session_start");
		const pending = host.run("cursor-fast", action);
		await catalog.started;

		const baseline = action === "off";
		const branchB = fastBranch("cached-model", baseline);
		host.setBranch(branchB);
		await host.emit("session_switch");
		expect(getFastMode("cached-model")).toBe(baseline);
		catalog.release();
		await pending;

		expect(host.ctx.sessionManager.getBranch()).toEqual(branchB);
		expect(host.appended).toEqual([]);
		expect(getFastMode("cached-model")).toBe(baseline);
		expect(host.notifications).toEqual([]);
	});

	test("returning to A does not revive its pending command", async () => {
		const catalog = deferCatalog("cached-model");
		const branchA = fastBranch("cached-model", false);
		const host = createHost({
			model: { id: "cached-model", provider: CURSOR_SDK_PROVIDER_ID },
			branch: branchA,
			getApiKeyForProvider: async () => "crsr_test",
		});
		registerModelControls(host.pi);
		await host.emit("session_start");
		const pending = host.run("cursor-fast", "on");
		await catalog.started;
		host.setBranch(fastBranch("cached-model", true));
		await host.emit("session_switch");
		host.setBranch(branchA);
		await host.emit("session_switch");
		catalog.release();
		await pending;

		expect(host.ctx.sessionManager.getBranch()).toEqual(branchA);
		expect(host.appended).toEqual([]);
		expect(getFastMode("cached-model")).toBe(false);
		expect(host.notifications).toEqual([]);
	});

	test.each(["session_start", "session_tree"])("%s invalidates a command already waiting for its key", async (event) => {
		const catalog = deferCatalog("cached-model");
		const key = deferred();
		const keyRequested = deferred();
		const host = createHost({
			model: { id: "cached-model", provider: CURSOR_SDK_PROVIDER_ID },
			getApiKeyForProvider: async () => {
				keyRequested.resolve();
				await key.promise;
				return "crsr_test";
			},
		});
		registerModelControls(host.pi);
		const pending = host.run("cursor-fast", "on");
		await keyRequested.promise;
		const branch = fastBranch("cached-model", false);
		host.setBranch(branch);
		await host.emit(event);
		key.resolve();
		await catalog.started;
		catalog.release();
		await pending;

		expect(host.ctx.sessionManager.getBranch()).toEqual(branch);
		expect(host.appended).toEqual([]);
		expect(getFastMode("cached-model")).toBe(false);
		expect(host.notifications).toEqual([]);
	});

	test("same-session cold discovery commits the model selected before key resolution", async () => {
		const catalog = deferCatalog("cached-model", "replacement-model");
		const key = deferred();
		const keyRequested = deferred();
		const selected = { id: "cached-model", provider: CURSOR_SDK_PROVIDER_ID };
		const host = createHost({
			model: selected,
			getApiKeyForProvider: async () => {
				keyRequested.resolve();
				await key.promise;
				return "crsr_test";
			},
		});
		registerModelControls(host.pi);
		const pending = host.run("cursor-fast", "on");
		await keyRequested.promise;
		selected.id = "composer-2.5";
		key.resolve();
		await catalog.started;
		host.setModel({ id: "replacement-model", provider: CURSOR_SDK_PROVIDER_ID });
		catalog.release();
		await pending;

		expect(host.appended).toEqual([
			{ type: controlsTestUtils.FAST_ENTRY_TYPE, data: { modelId: "cached-model", fast: true } },
		]);
		expect(getFastMode("cached-model")).toBe(true);
		expect(getFastMode("composer-2.5")).toBe(false);
		expect(getFastMode("replacement-model")).toBe(false);
		expect(host.notifications.map((item) => item.type)).toEqual(["info"]);
	});

	test("a destination command survives the stale waiter sharing its catalog query", async () => {
		const catalog = deferCatalog("cached-model");
		const host = createHost({
			model: { id: "cached-model", provider: CURSOR_SDK_PROVIDER_ID },
			getApiKeyForProvider: async () => "crsr_test",
		});
		registerModelControls(host.pi);
		const stale = host.run("cursor-fast", "on");
		await catalog.started;
		host.setBranch(fastBranch("cached-model", true));
		await host.emit("session_switch");
		const survivor = host.run("cursor-fast", "off");
		// Drain B's key-resolution microtasks while the shared catalog is still blocked.
		await new Promise<void>((resolve) => setImmediate(resolve));
		catalog.release();
		await Promise.all([stale, survivor]);

		expect(catalog.calls).toEqual(["crsr_test"]);
		expect(host.appended).toEqual([
			{ type: controlsTestUtils.FAST_ENTRY_TYPE, data: { modelId: "cached-model", fast: false } },
		]);
		expect(getFastMode("cached-model")).toBe(false);
		expect(host.notifications.map((item) => item.type)).toEqual(["info"]);
	});

});
