import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelListItem, ModelParameterDefinition, ModelParameterValue, ModelSelection, Run, RunResult, SDKAgent } from "@cursor/sdk";
import { AuthStorage, type Context } from "@oh-my-pi/pi-ai";
import { readModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { credentialScopeId } from "../../src/auth.ts";
import {
	__testUtils as catalogTestUtils,
	buildModelSelection,
	ensureCursorModels,
	getModelMetadata,
} from "../../src/catalog.ts";
import { CURSOR_API_KEY_ENV_VAR, CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import { __testUtils as liveRunTestUtils } from "../../src/live-run.ts";
import { streamCursorRuntime } from "../../src/provider.ts";
import { __testUtils as runtimeTestUtils } from "../../src/session-runtime.ts";
import { __testUtils as scopeTestUtils } from "../../src/session-scope.ts";
import cursorPlugin from "../../src/index.ts";

const KEY = "private-compat-key";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function parameter(id: string, values: string[]): ModelParameterDefinition {
	return { id, values: values.map((value) => ({ value })) };
}

function defaultVariant(params: ModelParameterValue[]): ModelListItem["variants"] {
	return [{ displayName: "default", isDefault: true, params }];
}

const OLD_MODEL: ModelListItem = {
	id: "old-model",
	displayName: "Old Model",
	parameters: [parameter("context", ["200k", "1m"]), parameter("fast", ["false", "true"])],
	variants: defaultVariant([
		{ id: "context", value: "1m" },
		{ id: "fast", value: "true" },
	]),
};

const NEW_MODEL: ModelListItem = {
	id: "new-model",
	displayName: "New Model",
	variants: defaultVariant([]),
};

function finishedRun(): Run {
	return {
		supports: () => false,
		wait: async (): Promise<RunResult> => ({ status: "finished" }) as RunResult,
	} as unknown as Run;
}

describe("OMP runtime ModelManager compatibility", () => {
	let root: string;
	let privateCacheRoot: string;
	let hostCachePath: string;
	let previousApiKey: string | undefined;
	let registration: ExtensionRuntime["pendingProviderRegistrations"][number];
	let extension: Extension;
	let authStores: AuthStorage[];

	beforeEach(async () => {
		previousApiKey = process.env[CURSOR_API_KEY_ENV_VAR];
		delete process.env[CURSOR_API_KEY_ENV_VAR];
		root = await mkdtemp(join(tmpdir(), "cursor-omp-models-"));
		privateCacheRoot = join(root, "cursor-private-cache");
		hostCachePath = join(root, "models.db");
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		scopeTestUtils.set(root, join(root, "session.jsonl"), "compat-session");
		authStores = [];
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setCacheRoot(privateCacheRoot);

		const runtime = new ExtensionRuntime();
		extension = await loadExtensionFromFactory(cursorPlugin, root, new EventBus(), runtime, "cursor-compat");
		const loaded = runtime.pendingProviderRegistrations.find(({ name }) => name === CURSOR_SDK_PROVIDER_ID);
		if (!loaded) throw new Error("Cursor SDK provider was not registered");
		registration = loaded;
	});

	afterEach(async () => {
		for (const auth of authStores) auth.close();
		catalogTestUtils.resetCatalog();
		runtimeTestUtils.clear();
		liveRunTestUtils.clear();
		scopeTestUtils.reset();
		if (previousApiKey === undefined) delete process.env[CURSOR_API_KEY_ENV_VAR];
		else process.env[CURSOR_API_KEY_ENV_VAR] = previousApiKey;
		await rm(root, { recursive: true, force: true });
	});

	async function createHost(): Promise<ModelRegistry> {
		const auth = await AuthStorage.create(join(root, `auth-${authStores.length}.db`));
		auth.setRuntimeApiKey(CURSOR_SDK_PROVIDER_ID, KEY);
		authStores.push(auth);
		const registry = new ModelRegistry(auth, join(root, "models.yml"), {
			cacheDbPath: hostCachePath,
			settings: Settings.isolated(),
		});
		registry.registerProvider(registration.name, registration.config, registration.sourceId);
		return registry;
	}

	async function seedHostCache(onFetch?: () => void): Promise<ModelRegistry> {
		catalogTestUtils.setListModels(async () => {
			onFetch?.();
			return [OLD_MODEL];
		});
		const registry = await createHost();
		await registry.refreshRuntimeProviders();
		return registry;
	}

	test("cold discovery populates both caches and a restarted host restores selection without a live host fetch", async () => {
		let liveFetches = 0;
		const first = await seedHostCache(() => liveFetches++);
		const cold = first.find(CURSOR_SDK_PROVIDER_ID, OLD_MODEL.id);
		expect(cold).toBeDefined();
		expect(liveFetches).toBe(1);

		const privateCache = await readFile(join(privateCacheRoot, `${credentialScopeId(KEY)}.json`), "utf8");
		expect(privateCache).not.toContain(KEY);
		expect(JSON.parse(privateCache).models.map((model: ModelListItem) => model.id)).toEqual([OLD_MODEL.id]);
		const hostCache = readModelCache(CURSOR_SDK_PROVIDER_ID, CACHE_TTL_MS, Date.now, hostCachePath);
		expect(hostCache?.authoritative).toBe(true);
		expect(hostCache?.models.map((model) => model.id)).toEqual([OLD_MODEL.id]);
		expect(JSON.stringify(hostCache)).not.toContain(KEY);

		catalogTestUtils.resetCatalog();
		catalogTestUtils.setCacheRoot(privateCacheRoot);
		catalogTestUtils.setListModels(async () => {
			liveFetches++;
			throw new Error("offline after restart");
		});
		const restarted = await createHost();
		await restarted.refreshRuntimeProviders();
		expect(liveFetches).toBe(1);
		const warm = restarted.find(CURSOR_SDK_PROVIDER_ID, OLD_MODEL.id);
		expect(warm).toEqual(cold);
		if (!warm) throw new Error("Warm host cache did not materialize the selected model");
		expect(warm.api).toBe(CURSOR_SDK_API);

		const created: ModelSelection[] = [];
		const sent: ModelSelection[] = [];
		runtimeTestUtils.setOpenAgent(async (input) => {
			created.push(input.model);
			return {
				agentId: "compat-agent",
				close() {},
				async [Symbol.asyncDispose]() {},
				async send(_message, options) {
					if (options?.model) sent.push(options.model);
					return finishedRun();
				},
			} as unknown as SDKAgent;
		});
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 1 } as Context["messages"][number]],
			tools: [],
		};
		for await (const _event of streamCursorRuntime(warm, context, {
			apiKey: KEY,
			cwd: root,
			onPayload: scopeTestUtils.bindRequest,
		})) {
			// Draining the adapter stream proves the first restarted turn completes.
		}

		expect(liveFetches).toBe(2);
		expect(getModelMetadata(OLD_MODEL.id, KEY)?.source).toBe("cache");
		const expected: ModelSelection = {
			id: OLD_MODEL.id,
			params: [
				{ id: "context", value: "200k" },
				{ id: "fast", value: "false" },
			],
		};
		expect(created).toEqual([expected]);
		expect(sent).toEqual([expected]);
	});

	test("a successful live catalog that removed the selected model rejects the stale selection", async () => {
		let liveFetches = 0;
		await seedHostCache(() => liveFetches++);
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setCacheRoot(privateCacheRoot);
		catalogTestUtils.setListModels(async () => {
			liveFetches++;
			return [NEW_MODEL];
		});
		const restarted = await createHost();
		await restarted.refreshProvider(CURSOR_SDK_PROVIDER_ID, "online");

		expect(liveFetches).toBe(2);
		expect(restarted.find(CURSOR_SDK_PROVIDER_ID, OLD_MODEL.id)).toBeUndefined();
		expect(restarted.find(CURSOR_SDK_PROVIDER_ID, NEW_MODEL.id)).toBeDefined();
		expect(() => buildModelSelection(OLD_MODEL.id, "off", { apiKey: KEY })).toThrow(
			/old-model.*no longer available.*select another/i,
		);
	});

	test("a failed live refresh may retain the host cache and restore selected metadata from the private cache", async () => {
		let liveFetches = 0;
		await seedHostCache(() => liveFetches++);
		catalogTestUtils.resetCatalog();
		catalogTestUtils.setCacheRoot(privateCacheRoot);
		catalogTestUtils.setListModels(async () => {
			liveFetches++;
			throw new Error("live catalog unavailable");
		});
		const restarted = await createHost();
		await restarted.refreshProvider(CURSOR_SDK_PROVIDER_ID, "online");
		expect(liveFetches).toBe(2);
		expect(restarted.find(CURSOR_SDK_PROVIDER_ID, OLD_MODEL.id)).toBeDefined();

		await ensureCursorModels(KEY);
		expect(liveFetches).toBe(3);
		expect(getModelMetadata(OLD_MODEL.id, KEY)?.source).toBe("cache");
		expect(buildModelSelection(OLD_MODEL.id, "off", { apiKey: KEY })).toEqual({
			id: OLD_MODEL.id,
			params: [
				{ id: "context", value: "1m" },
				{ id: "fast", value: "true" },
			],
		});
	});

	test("ordinary warm refresh reuses host cache, online refresh fetches, and a swallowed failure remains a command error", async () => {
		let liveFetches = 0;
		let failLive = false;
		catalogTestUtils.setListModels(async () => {
			liveFetches++;
			if (failLive) throw new Error(`upstream unavailable ${KEY}`);
			return [OLD_MODEL];
		});
		const registry = await createHost();
		await registry.refreshRuntimeProviders();
		expect(liveFetches).toBe(1);
		await registry.refreshRuntimeProviders();
		expect(liveFetches).toBe(1);
		await registry.refreshProvider(CURSOR_SDK_PROVIDER_ID, "online");
		expect(liveFetches).toBe(2);

		failLive = true;
		const notifications: Array<{ message: string; type?: string }> = [];
		const command = extension.commands.get("cursor-refresh-models");
		if (!command) throw new Error("Cursor refresh command was not registered");
		const sessionManager = {
			getSessionId: () => "compat-session",
			getSessionFile: () => join(root, "session.jsonl"),
		};
		await command.handler("", {
			cwd: root,
			hasUI: true,
			model: registry.find(CURSOR_SDK_PROVIDER_ID, OLD_MODEL.id),
			modelRegistry: registry,
			sessionManager,
			ui: {
				notify(message: string, type?: string) {
					notifications.push({ message, type });
				},
			},
		} as unknown as ExtensionCommandContext);

		expect(liveFetches).toBe(3);
		expect(registry.find(CURSOR_SDK_PROVIDER_ID, OLD_MODEL.id)).toBeDefined();
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.type).toBe("error");
		expect(notifications[0]?.message).toContain("Failed to refresh Cursor SDK models");
		expect(notifications[0]?.message).not.toContain(KEY);
	});
});
