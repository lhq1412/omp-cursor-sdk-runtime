import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialScopeId } from "../../src/auth.ts";
import type { ModelListItem, ModelParameterDefinition, ModelParameterValue } from "@cursor/sdk";
import {
	__testUtils,
	buildModelSelection,
	ensureCursorModels,
	fallbackModels,
	fetchCursorModels,
	getModelMetadata,
	parseCursorContextWindowValue,
} from "../../src/catalog.ts";

function param(id: string, values: string[]): ModelParameterDefinition {
	return { id, values: values.map((value) => ({ value })) };
}

function item(partial: Partial<ModelListItem> & Pick<ModelListItem, "id">): ModelListItem {
	return {
		displayName: partial.displayName ?? partial.id,
		...partial,
	};
}

function defaultVariant(params: ModelParameterValue[]): ModelListItem["variants"] {
	return [{ params, displayName: "default", isDefault: true }];
}

beforeEach(() => {
	__testUtils.resetCatalog();
});

describe("context window parse", () => {
	test("accepts integer and decimal k/m", () => {
		expect(parseCursorContextWindowValue("272k")).toBe(272_000);
		expect(parseCursorContextWindowValue("1.5k")).toBe(1_500);
		expect(parseCursorContextWindowValue("1m")).toBe(1_000_000);
		expect(parseCursorContextWindowValue("0.2m")).toBe(200_000);
		expect(parseCursorContextWindowValue("max")).toBeUndefined();
		expect(parseCursorContextWindowValue("0k")).toBeUndefined();
	});
});

describe("identity mapping", () => {
	test("two distinct parseable contexts collapse to one extended row", () => {
		const models = __testUtils.registerModelItems([
			item({
				id: "gpt-5.5",
				parameters: [
					param("context", ["1m", "272k"]),
					param("reasoning", ["none", "low", "medium", "high"]),
					param("fast", ["false", "true"]),
				],
				variants: defaultVariant([
					{ id: "context", value: "1m" },
					{ id: "reasoning", value: "medium" },
					{ id: "fast", value: "false" },
				]),
			}),
		]);
		expect(models.map((model) => model.id)).toEqual(["gpt-5.5"]);
		expect(models[0]?.contextWindow).toBe(1_000_000);
		expect(models[0]?.cost).toMatchObject({ longContext: { inputThreshold: 272_000 } });
		expect(getModelMetadata("gpt-5.5")?.extendedContext).toEqual({
			standardValue: "272k",
			extendedValue: "1m",
			standardContextWindow: 272_000,
		});
		expect(getModelMetadata("gpt-5.5@272k")).toBeUndefined();
		expect(getModelMetadata("gpt-5.5@1m")).toBeUndefined();
		expect(buildModelSelection("gpt-5.5", "off", { extendedContextEnabled: false }).params).toEqual(
			expect.arrayContaining([{ id: "context", value: "272k" }]),
		);
	});

	test("three-tier and unparseable pairs emit base plus non-default @context rows", () => {
		__testUtils.registerModelItems([
			item({
				id: "three-tier",
				parameters: [param("context", ["128k", "272k", "1m"])],
				variants: defaultVariant([{ id: "context", value: "272k" }]),
			}),
			item({
				id: "opaque",
				parameters: [param("context", ["default", "max"])],
				variants: defaultVariant([{ id: "context", value: "default" }]),
			}),
		]);
		expect(getModelMetadata("three-tier")?.contextWindow).toBe(272_000);
		expect(getModelMetadata("three-tier@128k")?.contextWindow).toBe(128_000);
		expect(getModelMetadata("three-tier@1m")?.contextWindow).toBe(1_000_000);
		expect(getModelMetadata("three-tier")?.extendedContext).toBeUndefined();
		expect(getModelMetadata("opaque")?.contextWindow).toBe(200_000);
		expect(getModelMetadata("opaque@max")?.context).toBe("max");
		expect(getModelMetadata("opaque@max")?.contextWindow).toBe(200_000);
	});

	test("aliases and duplicate ids never become extra rows", () => {
		const models = __testUtils.registerModelItems([
			item({
				id: "composer-2.5",
				aliases: ["composer", "composer-2-5"],
				parameters: [param("fast", ["false", "true"])],
				variants: defaultVariant([{ id: "fast", value: "true" }]),
			}),
			item({
				id: "composer-2.5",
				displayName: "duplicate",
				aliases: ["composer-latest"],
			}),
		]);
		expect(models.map((model) => model.id)).toEqual(["composer-2.5"]);
		expect(getModelMetadata("composer")).toBeUndefined();
		expect(getModelMetadata("composer-2-5")).toBeUndefined();
		expect(getModelMetadata("composer-2.5")?.supportsFast).toBe(true);
		expect(getModelMetadata("cursor-sdk/composer-2.5")?.baseModelId).toBe("composer-2.5");
	});
});

describe("reference pricing", () => {
	test("exact IDs and explicit Claude price aliases preserve SDK context and wire selection", async () => {
		__testUtils.setListModels(async () => [
			item({
				id: "gpt-5.5",
				parameters: [param("context", ["128k", "272k", "1m"])],
				variants: defaultVariant([{ id: "context", value: "272k" }]),
			}),
			item({
				id: "claude-4.5-sonnet",
				parameters: [param("thinking", ["false", "true"]), param("effort", ["low", "high"])],
				variants: defaultVariant([{ id: "thinking", value: "true" }, { id: "effort", value: "low" }]),
			}),
		]);
		const models = await fetchCursorModels("reference-key");
		expect(models.map((model) => model.id)).toEqual([
			"claude-4.5-sonnet", "gpt-5.5", "gpt-5.5@128k", "gpt-5.5@1m",
		]);
		for (const id of ["gpt-5.5", "gpt-5.5@128k", "gpt-5.5@1m"]) {
			expect(models.find((model) => model.id === id)?.cost).toEqual({
				input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0,
			});
		}
		expect(models.find((model) => model.id === "gpt-5.5@128k")?.contextWindow).toBe(128_000);
		expect(buildModelSelection("gpt-5.5@128k", "off", { apiKey: "reference-key" })).toEqual({
			id: "gpt-5.5", params: [{ id: "context", value: "128k" }],
		});
		expect(models.find((model) => model.id === "claude-4.5-sonnet")?.cost).toEqual({
			input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
		});
		expect(buildModelSelection("claude-4.5-sonnet", "high", { apiKey: "reference-key" })).toEqual({
			id: "claude-4.5-sonnet",
			params: [{ id: "thinking", value: "true" }, { id: "effort", value: "high" }],
		});
	});

	test("unknown SKUs cannot borrow prices from display names, SDK aliases or nearby model IDs", async () => {
		const ids = [
			"gpt-5.5-future", "claude-4.5-sonnet-pro", "gpt-5.5-fast", "gpt-5.5-search",
			"claude-4.5-sonnet-fast", "gemini-3-pro",
		];
		__testUtils.setListModels(async () => ids.map((id) => item({
			id,
			displayName: "gpt-5.5",
			aliases: ["gpt-5.5", "claude-sonnet-4-5"],
		})));
		const models = await fetchCursorModels("unknown-key");
		expect(models.map((model) => model.id).sort()).toEqual([...ids].sort());
		for (const model of models) {
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	test("native long-context pricing cannot replace SDK thresholds or create context capabilities", async () => {
		__testUtils.setListModels(async () => [
			item({
				id: "gpt-5.6",
				parameters: [param("context", ["128k", "1m"])],
				variants: defaultVariant([{ id: "context", value: "1m" }]),
			}),
			item({
				id: "gpt-5.6-luna",
				parameters: [param("context", ["128k"])],
				variants: defaultVariant([{ id: "context", value: "128k" }]),
			}),
		]);
		const models = await fetchCursorModels("threshold-key");
		expect(models.find((model) => model.id === "gpt-5.6")?.cost).toEqual({
			input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5,
			longContext: {
				inputThreshold: 128_000,
				input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5,
			},
		});
		expect(buildModelSelection("gpt-5.6", "off", { apiKey: "threshold-key", extendedContextEnabled: false })).toEqual({
			id: "gpt-5.6", params: [{ id: "context", value: "128k" }],
		});
		expect(buildModelSelection("gpt-5.6", "off", { apiKey: "threshold-key", extendedContextEnabled: true })).toEqual({
			id: "gpt-5.6", params: [{ id: "context", value: "1m" }],
		});
		const standardOnly = models.find((model) => model.id === "gpt-5.6-luna");
		expect(standardOnly?.cost).toEqual({ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 });
		expect(standardOnly?.contextWindow).toBe(128_000);
		expect(buildModelSelection("gpt-5.6-luna", "off", { apiKey: "threshold-key", extendedContextEnabled: true })).toEqual({
			id: "gpt-5.6-luna", params: [{ id: "context", value: "128k" }],
		});
	});
});

describe("thinking selection", () => {
	test("thinking+effort off writes thinking=false and drops effort", () => {
		__testUtils.registerModelItems([
			item({
				id: "haiku",
				parameters: [param("thinking", ["false", "true"]), param("effort", ["low", "high"])],
				variants: defaultVariant([
					{ id: "thinking", value: "true" },
					{ id: "effort", value: "high" },
				]),
			}),
		]);
		const metadata = getModelMetadata("haiku");
		expect(metadata?.supportsReasoning).toBe(true);
		expect(metadata?.thinkingLevelMap?.high).toBe("high");
		expect(metadata?.thinkingLevelMap?.xhigh).toBeNull();
		expect(buildModelSelection("haiku", "off").params).toEqual([{ id: "thinking", value: "false" }]);
		expect(buildModelSelection("haiku", "high").params).toEqual([
			{ id: "thinking", value: "true" },
			{ id: "effort", value: "high" },
		]);
	});

	test("value map prefers effort over reasoning and accepts extra-high as xhigh", () => {
		__testUtils.registerModelItems([
			item({
				id: "mixed",
				parameters: [
					param("thinking", ["false", "true"]),
					param("reasoning", ["none", "low", "high"]),
					param("effort", ["low", "medium", "extra-high"]),
				],
				variants: defaultVariant([
					{ id: "thinking", value: "true" },
					{ id: "reasoning", value: "high" },
					{ id: "effort", value: "medium" },
				]),
			}),
		]);
		const map = getModelMetadata("mixed")?.thinkingLevelMap;
		expect(map?.off).toBe("none");
		expect(map?.high).toBeNull();
		expect(map?.xhigh).toBe("extra-high");
		expect(buildModelSelection("mixed", "xhigh").params).toEqual([
			{ id: "thinking", value: "true" },
			{ id: "reasoning", value: "high" },
			{ id: "effort", value: "extra-high" },
		]);
		expect(buildModelSelection("mixed", "off").params).toEqual([
			{ id: "thinking", value: "true" },
			{ id: "reasoning", value: "none" },
			{ id: "effort", value: "medium" },
		]);
	});

	test("unsupported thinking levels leave variant defaults", () => {
		__testUtils.registerModelItems([
			item({
				id: "bool-only",
				parameters: [param("thinking", ["false", "true"])],
				variants: defaultVariant([{ id: "thinking", value: "true" }]),
			}),
		]);
		expect(buildModelSelection("bool-only", "off").params).toEqual([{ id: "thinking", value: "false" }]);
		expect(buildModelSelection("bool-only", "low").params).toEqual([{ id: "thinking", value: "true" }]);
		expect(buildModelSelection("bool-only", "high").params).toEqual([{ id: "thinking", value: "true" }]);
		expect(buildModelSelection("missing", "high")).toEqual({ id: "missing" });
	});
});

describe("fast and fallback", () => {
	test("fast is a caller boolean, not an identity row", () => {
		__testUtils.registerModelItems([
			item({
				id: "composer-2.5",
				parameters: [param("fast", ["false", "true"])],
				variants: defaultVariant([{ id: "fast", value: "true" }]),
			}),
		]);
		expect(getModelMetadata("composer-2.5")?.defaultFast).toBe(true);
		expect(buildModelSelection("composer-2.5", "off", { fastEnabled: false }).params).toEqual([
			{ id: "fast", value: "false" },
		]);
		expect(getModelMetadata("composer-2.5@fast")).toBeUndefined();
	});

	test("composer fallback supports fast and does not wipe live metadata", () => {
		__testUtils.registerModelItems([
			item({
				id: "gpt-5.5",
				parameters: [param("context", ["272k", "1m"])],
				variants: defaultVariant([{ id: "context", value: "1m" }]),
			}),
		]);
		const fallback = fallbackModels();
		expect(fallback).toHaveLength(1);
		expect(fallback[0]?.id).toBe("composer-2.5");
		expect(fallback[0]?.reasoning).toBe(false);
		expect(getModelMetadata("gpt-5.5")?.contextWindow).toBe(1_000_000);
		__testUtils.resetCatalog();
		const empty = fallbackModels();
		expect(empty[0]?.reasoning).toBe(false);
		expect(getModelMetadata("composer-2.5")?.supportsFast).toBe(true);
		expect(getModelMetadata("composer-2.5")?.supportsReasoning).toBe(false);
	});
});

describe("hydration", () => {
	test("failed live refresh keeps the last catalog and redacts the key", async () => {
		const key = "crsr_secret_key";
		__testUtils.setListModels(async () => [
			item({
				id: "gpt-5.5",
				parameters: [param("context", ["272k", "1m"])],
				variants: defaultVariant([{ id: "context", value: "1m" }]),
			}),
		]);
		await fetchCursorModels(key);
		expect(getModelMetadata("gpt-5.5")?.contextWindow).toBe(1_000_000);
		__testUtils.setListModels(async () => {
			throw new Error(`upstream rejected ${key}`);
		});
		const failure = await fetchCursorModels(key).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain(key);
		expect(getModelMetadata("gpt-5.5")?.contextWindow).toBe(1_000_000);
	});

	test("ensure hydrates once per credential and does not reuse another key", async () => {
		const calls: string[] = [];
		__testUtils.setListModels(async (apiKey) => {
			calls.push(apiKey);
			return [
				item({
					id: apiKey === "key-a" ? "model-a" : "model-b",
					variants: defaultVariant([]),
				}),
			];
		});
		await ensureCursorModels("key-a");
		await ensureCursorModels("key-a");
		expect(calls).toEqual(["key-a"]);
		expect(getModelMetadata("model-a")).toBeDefined();
		await ensureCursorModels("key-b");
		expect(calls).toEqual(["key-a", "key-b"]);
		expect(getModelMetadata("model-a")).toBeUndefined();
		expect(getModelMetadata("model-b")).toBeDefined();
		expect(getModelMetadata("model-a", "key-a")?.piModelId).toBe("model-a");
		expect(getModelMetadata("model-b", "key-b")?.piModelId).toBe("model-b");
		await ensureCursorModels("key-a");
		expect(calls).toEqual(["key-a", "key-b"]);
	});

	test("empty live catalog is a discovery error and preserves prior state", async () => {
		__testUtils.setListModels(async () => [item({ id: "model-a", variants: defaultVariant([]) })]);
		await fetchCursorModels("key-a");
		expect(getModelMetadata("model-a")?.piModelId).toBe("model-a");
		__testUtils.setListModels(async () => []);
		await expect(fetchCursorModels("key-b")).rejects.toThrow(/empty model catalog/);
		expect(getModelMetadata("model-a")?.piModelId).toBe("model-a");
		expect(getModelMetadata("model-a", "key-a")?.piModelId).toBe("model-a");
		await expect(ensureCursorModels("key-b")).rejects.toThrow(/empty model catalog/);
		expect(getModelMetadata("model-a")?.piModelId).toBe("model-a");
		await expect(fetchCursorModels("key-a")).rejects.toThrow(/empty model catalog/);
		expect(getModelMetadata("model-a", "key-a")?.piModelId).toBe("model-a");
	});

	test("concurrent different keys keep credential-scoped snapshots", async () => {
		let releaseA: () => void = () => undefined;
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		__testUtils.setListModels(async (apiKey) => {
			if (apiKey === "key-a") await gateA;
			return [
				item({
					id: apiKey === "key-a" ? "model-a" : "model-b",
					parameters: apiKey === "key-a" ? [param("fast", ["false", "true"])] : undefined,
					variants: defaultVariant(apiKey === "key-a" ? [{ id: "fast", value: "true" }] : []),
				}),
			];
		});
		const pendingA = fetchCursorModels("key-a");
		const pendingB = fetchCursorModels("key-b");
		releaseA();
		const [modelsA, modelsB] = await Promise.all([pendingA, pendingB]);
		expect(modelsA.map((model) => model.id)).toEqual(["model-a"]);
		expect(modelsB.map((model) => model.id)).toEqual(["model-b"]);
		expect(getModelMetadata("model-a")).toBeUndefined();
		expect(getModelMetadata("model-b")).toBeDefined();
		expect(getModelMetadata("model-a", "key-a")?.piModelId).toBe("model-a");
		expect(getModelMetadata("model-b", "key-b")?.piModelId).toBe("model-b");
		expect(buildModelSelection("model-a", "off", { apiKey: "key-a", fastEnabled: false }).params).toEqual([
			{ id: "fast", value: "false" },
		]);
		expect(buildModelSelection("model-a", "off")).toEqual({ id: "model-a" });
	});

	test("composer fallback metadata is available before network", () => {
		expect(getModelMetadata("composer-2.5")?.supportsFast).toBe(true);
		expect(getModelMetadata("composer-2.5")?.supportsReasoning).toBe(false);
		expect(getModelMetadata("gpt-5.5")).toBeUndefined();
		expect(buildModelSelection("missing", "high")).toEqual({ id: "missing" });
	});
});

describe("persisted catalog", () => {
	let root: string;
	const key = "cache-key-secret";
	const discovered = item({
		id: "cached-model",
		parameters: [param("context", ["200k", "1m"]), param("fast", ["false", "true"])],
		variants: defaultVariant([{ id: "context", value: "1m" }, { id: "fast", value: "true" }]),
	});

	function restartOffline() {
		__testUtils.resetCatalog();
		__testUtils.setCacheRoot(root);
		__testUtils.setListModels(async () => { throw new Error("discovery offline"); });
	}

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "cursor-model-cache-"));
		__testUtils.setCacheRoot(root);
		__testUtils.setListModels(async () => [discovered]);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("reloads validated same-key selection across reset without turning refresh into success", async () => {
		await fetchCursorModels(key);
		expect(getModelMetadata("cached-model", key)?.source).toBe("sdk");
		const path = join(root, `${credentialScopeId(key)}.json`);
		expect(await readFile(path, "utf8")).not.toContain(key);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		restartOffline();
		await ensureCursorModels(key);
		expect(getModelMetadata("cached-model", key)?.source).toBe("cache");
		expect(buildModelSelection("cached-model", "off", { apiKey: key, extendedContextEnabled: false, fastEnabled: false })).toEqual({
			id: "cached-model",
			params: [{ id: "context", value: "200k" }, { id: "fast", value: "false" }],
		});
		expect(getModelMetadata("unknown-model", key)).toBeUndefined();
		expect(() => buildModelSelection("unknown-model", "off", { apiKey: key })).toThrow();
		expect(buildModelSelection("unknown-model", "off", { apiKey: "other-key" })).toEqual({ id: "unknown-model" });
		await expect(fetchCursorModels(key)).rejects.toThrow("discovery offline");
		await expect(ensureCursorModels("other-key")).rejects.toThrow("discovery offline");
		expect(getModelMetadata("cached-model", "other-key")).toBeUndefined();
	});

	test("preserves variant-only parameter IDs and values through live discovery and disk reload", async () => {
		const models = [
			item({
				id: "variant-only",
				variants: defaultVariant([{ id: "routing", value: "Auto" }]),
			}),
			item({
				id: "unadvertised-value",
				parameters: [param("routing", ["standard"]), param("region", [])],
				variants: [
					...defaultVariant([{ id: "routing", value: "Premium" }, { id: "region", value: "" }]),
					{ displayName: "alternate", params: [{ id: "routing", value: "Preview" }] },
				],
			}),
		];
		const selections = [
			{ id: "variant-only", params: [{ id: "routing", value: "Auto" }] },
			{ id: "unadvertised-value", params: [{ id: "routing", value: "Premium" }, { id: "region", value: "" }] },
		];
		__testUtils.setListModels(async () => models);
		expect((await fetchCursorModels(key)).map((model) => model.id).sort()).toEqual(models.map((model) => model.id).sort());
		expect(models.map((model) => buildModelSelection(model.id, "off", { apiKey: key }))).toEqual(selections);
		const persisted = JSON.parse(await readFile(join(root, `${credentialScopeId(key)}.json`), "utf8"));
		expect(persisted.models.map((model: ModelListItem) => model.variants)).toEqual(models.map((model) => model.variants));
		expect(persisted.models.map((model: ModelListItem) => model.parameters)).toEqual(models.map((model) => model.parameters ?? []));
		restartOffline();
		await ensureCursorModels(key);
		expect(models.map((model) => getModelMetadata(model.id, key)?.source)).toEqual(["cache", "cache"]);
		expect(models.map((model) => buildModelSelection(model.id, "off", { apiKey: key }))).toEqual(selections);
	});

	test("rejects malformed, foreign credential, foreign model and ambiguous variant data", async () => {
		await fetchCursorModels(key);
		const path = join(root, `${credentialScopeId(key)}.json`);
		const valid = JSON.parse(await readFile(path, "utf8"));
		for (const content of [
			"{",
			JSON.stringify({ ...valid, credential: credentialScopeId("other-key") }),
			JSON.stringify({ ...valid, version: 2 }),
			JSON.stringify({ ...valid, models: [{ ...discovered, id: "other-provider/model" }] }),
			JSON.stringify({ ...valid, models: [{ ...discovered, variants: [{ displayName: "default", params: [{ id: 1, value: "true" }] }] }] }),
			JSON.stringify({ ...valid, models: [{ ...discovered, variants: [{ displayName: "default", params: [{ id: "fast", value: true }] }] }] }),
			JSON.stringify({ ...valid, models: [{ ...discovered, variants: defaultVariant([{ id: "fast", value: "true" }, { id: "fast", value: "false" }]) }] }),
		]) {
			await writeFile(path, content);
			restartOffline();
			await expect(ensureCursorModels(key)).rejects.toThrow("discovery offline");
			expect(getModelMetadata("cached-model", key)).toBeUndefined();
		}
		__testUtils.setListModels(async () => [discovered]);
		await ensureCursorModels(key);
		expect(getModelMetadata("cached-model", key)?.source).toBe("sdk");
	});
	test("invalid live metadata cannot replace a previously validated cache", async () => {
		await fetchCursorModels(key);
		__testUtils.setListModels(async () => [{
			...discovered,
			variants: defaultVariant([{ id: "fast", value: "true" }, { id: "fast", value: "false" }]),
		}]);
		await expect(fetchCursorModels(key)).rejects.toThrow();
		restartOffline();
		await ensureCursorModels(key);
		expect(buildModelSelection("cached-model", "off", { apiKey: key }).params).toEqual([
			{ id: "context", value: "1m" }, { id: "fast", value: "true" },
		]);
	});


	test("rejects unsafe permissions and symlinks without expanding existing modes", async () => {
		await fetchCursorModels(key);
		const path = join(root, `${credentialScopeId(key)}.json`);
		await chmod(path, 0o644);
		restartOffline();
		await expect(ensureCursorModels(key)).rejects.toThrow("discovery offline");
		__testUtils.setListModels(async () => [discovered]);
		await fetchCursorModels(key);
		expect((await stat(path)).mode & 0o777).toBe(0o644);
		await chmod(path, 0o400);
		await fetchCursorModels(key);
		expect((await stat(path)).mode & 0o777).toBe(0o400);
		const target = join(root, "target.json");
		await writeFile(target, await readFile(path), { mode: 0o600 });
		await rm(path);
		await symlink(target, path);
		restartOffline();
		await expect(ensureCursorModels(key)).rejects.toThrow("discovery offline");
		await rm(path);
		await chmod(root, 0o755);
		__testUtils.setListModels(async () => [discovered]);
		await fetchCursorModels(key);
		restartOffline();
		await expect(ensureCursorModels(key)).rejects.toThrow("discovery offline");
		expect((await stat(root)).mode & 0o777).toBe(0o755);
	});
});
