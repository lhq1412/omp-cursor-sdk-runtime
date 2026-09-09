import { beforeEach, describe, expect, test } from "bun:test";
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
		await expect(fetchCursorModels(key)).rejects.toThrow(/Cursor SDK model discovery failed: upstream rejected <redacted>/);
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
