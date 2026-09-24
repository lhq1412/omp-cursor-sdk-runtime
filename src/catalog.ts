import {
	Cursor,
	type ModelListItem,
	type ModelParameterDefinition,
	type ModelParameterValue,
	type ModelSelection,
} from "@cursor/sdk";
import { Effort, type ModelCost } from "@oh-my-pi/pi-ai";
import { parseRevision, parseRevisionConstraint, revisionSatisfies } from "@oh-my-pi/pi-catalog/compat/revision";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { credentialScopeId } from "./auth.js";
import { CURSOR_SDK_PROVIDER_ID, DEFAULT_MODEL_ID } from "./constants.js";
import { sanitizeCursorProviderError } from "./errors.js";
import { modelCacheRoot, readModelCache, validatedModelItems, writeModelCache } from "./model-cache.js";

export type ModelThinkingLevel = "off" | Effort;
type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export interface CursorModelMetadata {
	source: "sdk" | "cache" | "fallback";
	piModelId: string;
	baseModelId: string;
	displayName: string;
	defaultParams: ModelParameterValue[];
	context?: string;
	extendedContext?: {
		standardValue: string;
		extendedValue: string;
		standardContextWindow: number;
	};
	contextWindow: number;
	supportsFast: boolean;
	defaultFast: boolean;
	supportsReasoning: boolean;
	/** Mandatory-reasoning models clamp thinking-off to the lowest supported effort. */
	requiresEffort?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	/** SDK id written for effort levels: `effort` or `reasoning_effort`. */
	effortParameterId?: string;
	parameterIds: {
		context: boolean;
		reasoning: boolean;
		effort: boolean;
		thinking: boolean;
		fast: boolean;
	};
}

export interface ModelSelectionRuntimeOptions {
	fastEnabled?: boolean;
	extendedContextEnabled?: boolean;
	apiKey?: string;
}

type ListModels = (apiKey: string) => Promise<readonly ModelListItem[]>;

const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_TOKENS = 64_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const PRICE_PROVIDERS = ["cursor", "openai", "anthropic", "google", "xai"] as const;
const BASE_PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const CLAUDE_PRICE_IDS: Readonly<Record<string, string>> = {
	"claude-4-sonnet": "claude-sonnet-4-0",
	"claude-4.5-sonnet": "claude-sonnet-4-5",
	"claude-4.5-opus": "claude-opus-4-5",
	"claude-4.5-opus-high": "claude-opus-4-5",
	"claude-4.6-opus": "claude-opus-4-6",
	"claude-4.6-opus-high": "claude-opus-4-6",
	"claude-4.6-opus-max": "claude-opus-4-6",
	"claude-4.6-sonnet": "claude-sonnet-4-6",
	"claude-4.6-sonnet-medium": "claude-sonnet-4-6",
};
const TEXT_AND_IMAGE_INPUT: ProviderModelConfig["input"] = ["text", "image"];
const OMP_THINKING_EFFORTS = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
] as const;

const COMPOSER_FALLBACK_ITEM: ModelListItem = {
	id: DEFAULT_MODEL_ID,
	displayName: "Composer 2.5",
	aliases: ["composer-latest", "composer", "composer-2-5"],
	parameters: [
		{
			id: "fast",
			displayName: "Fast",
			values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
		},
	],
	variants: [
		{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2.5", isDefault: true },
		{ params: [{ id: "fast", value: "false" }], displayName: "Composer 2.5" },
	],
};

type CatalogState = {
	key: string | undefined;
	metadata: Map<string, CursorModelMetadata>;
};

let state: CatalogState = { key: undefined, metadata: new Map() };
const catalogsByCredential = new Map<string, Map<string, CursorModelMetadata>>();
const modelIdsByCredential = new Map<string, string[]>();
const LOCAL_MODEL_CATALOG_ENV = "CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON";
/** Last catalog JSON this process published. A different value is caller-owned. */
let ownedLocalCatalogJson: string | undefined;
let listModelsImpl: ListModels | undefined;
let catalogMutation: Promise<void> = Promise.resolve();
let composerFallbackMetadata: Map<string, CursorModelMetadata> | undefined;
let cacheRoot: string | null | undefined;

function serializeCatalogMutation<T>(fn: () => Promise<T>): Promise<T> {
	const run = catalogMutation.then(fn, fn);
	catalogMutation = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function cloneParams(params: ModelParameterValue[]): ModelParameterValue[] {
	return params.map((param) => ({ ...param }));
}

export function parseCursorContextWindowValue(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2]?.toLowerCase();
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	return Math.round(amount * (unit === "m" ? 1_000_000 : 1_000));
}

function revisionMatches(revision: string | undefined, constraint: string): boolean {
	if (!revision) return false;
	const parsed = parseRevision(revision);
	const terms = parseRevisionConstraint(constraint);
	return parsed !== undefined && terms !== undefined && revisionSatisfies(parsed, terms);
}

/** OMP 18.2.1 `providers/cursor.kdl` context-window-floor; `auto` is Cursor Auto. */
function cursorContextWindowFloor(modelId: string): number | undefined {
	const slash = modelId.lastIndexOf("/");
	const bare = (slash === -1 ? modelId : modelId.slice(slash + 1)).trim().toLowerCase();
	if (bare === "default" || bare === "auto") return 256_000;
	if (bare === "k3") return 1_000_000;

	const identity = classifyModel("cursor", modelId, { lenient: true });
	if (identity.class === "kimi" && identity.family === "k3") return 1_000_000;
	if (identity.class === "kimi" && identity.family === "k2.7-code") return 262_000;
	if (identity.class === "anthropic" && identity.family === "fable") return 300_000;
	if (identity.class === "anthropic" && identity.family === "opus" && revisionMatches(identity.revision, ">=5 <6")) {
		return 300_000;
	}
	if (identity.class === "xai" && identity.family === "grok" && revisionMatches(identity.revision, ">=4.5 <4.8")) {
		return 256_000;
	}
	if (identity.class === "openai" && revisionMatches(identity.revision, ">=5.6 <5.7")) return 272_000;
	return undefined;
}

// ponytail: Local SDK 1.0.32 rejects Grok 4.7 500k; delete when live probe passes.
function isRejectedLocalContext(baseModelId: string, context: string): boolean {
	return normalizeParamValue(context) === "500k" && /^grok-4\.7($|[-@])/i.test(baseModelId);
}

function advertisedContextWindow(
	modelId: string,
	context: string | undefined,
	twoTierExtended?: number,
): number {
	if (twoTierExtended !== undefined) return twoTierExtended;
	const parsed = context ? parseCursorContextWindowValue(context) : undefined;
	if (parsed !== undefined) return parsed;
	return cursorContextWindowFloor(modelId) ?? FALLBACK_CONTEXT_WINDOW;
}

function normalizeParamValue(value: string): string {
	return value.trim().toLowerCase();
}

function getParameter(item: ModelListItem, id: string): ModelParameterDefinition | undefined {
	return item.parameters?.find((parameter) => parameter.id === id);
}

function getDefaultParam(item: ModelListItem, id: string): string | undefined {
	const variant = item.variants?.find((candidate) => candidate.isDefault) ?? item.variants?.[0];
	return variant?.params?.find((param) => param.id === id)?.value;
}

function getContextValues(item: ModelListItem): string[] {
	const values: string[] = [];
	const used = new Set<string>();
	for (const { value } of getParameter(item, "context")?.values ?? []) {
		const normalized = normalizeParamValue(value);
		if (!normalized || used.has(normalized)) continue;
		used.add(normalized);
		values.push(value);
	}
	return values;
}

function encodePiModelId(modelId: string, context?: string): string {
	return context ? `${modelId}@${context}` : modelId;
}

function getTwoTierContextPolicy(contextValues: string[]) {
	if (contextValues.length !== 2) return undefined;
	const parsed = contextValues.map((value) => ({
		value,
		contextWindow: parseCursorContextWindowValue(value),
	}));
	if (parsed.some(({ contextWindow }) => contextWindow === undefined)) return undefined;
	parsed.sort((a, b) => (a.contextWindow ?? 0) - (b.contextWindow ?? 0));
	const standard = parsed[0];
	const extended = parsed[1];
	if (!standard?.contextWindow || !extended?.contextWindow || standard.contextWindow === extended.contextWindow) {
		return undefined;
	}
	return {
		standard: { value: standard.value, contextWindow: standard.contextWindow },
		extended: { value: extended.value, contextWindow: extended.contextWindow },
	};
}

interface SelectionIdentity {
	model: ModelListItem;
	context?: string;
	contextTiers?: {
		standard: { value: string; contextWindow: number };
		extended: { value: string; contextWindow: number };
	};
	piModelId: string;
}

function getCursorModelSelectionIdentities(items: readonly ModelListItem[]): SelectionIdentity[] {
	const identities: SelectionIdentity[] = [];
	const usedPiModelIds = new Set<string>();
	const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
	for (const model of sorted) {
		if (!model.id.trim()) continue;
		const contextValues = getContextValues(model);
		const defaultContext = getDefaultParam(model, "context");
		const contextTiers = getTwoTierContextPolicy(contextValues);
		const contexts = contextTiers
			? [undefined]
			: [
					undefined,
					...contextValues.filter(
						(value) => normalizeParamValue(value) !== normalizeParamValue(defaultContext ?? ""),
					),
				];
		for (const context of contexts) {
			const piModelId = encodePiModelId(model.id, context);
			if (usedPiModelIds.has(piModelId)) continue;
			usedPiModelIds.add(piModelId);
			identities.push({
				model,
				...(context ? { context } : {}),
				...(contextTiers ? { contextTiers } : {}),
				piModelId,
			});
		}
	}
	return identities;
}

function hasBooleanValues(parameter: ModelParameterDefinition | undefined): boolean {
	const values = new Set((parameter?.values ?? []).map((value) => value.value.toLowerCase()));
	return values.has("false") && values.has("true");
}

function getParameterValue(parameter: ModelParameterDefinition | undefined, lowerValue: string): string | null {
	return parameter?.values.find((candidate) => candidate.value.toLowerCase() === lowerValue)?.value ?? null;
}

function getPreferredParameterValue(
	parameter: ModelParameterDefinition | undefined,
	lowerValues: string[],
): string | null {
	for (const value of lowerValues) {
		const candidate = getParameterValue(parameter, value);
		if (candidate) return candidate;
	}
	return null;
}

function mapComparableLevel(
	parameter: ModelParameterDefinition | undefined,
	level: Exclude<ModelThinkingLevel, "off">,
): string | null {
	if (level === Effort.XHigh) return getPreferredParameterValue(parameter, ["xhigh", "extra-high"]);
	return getParameterValue(parameter, level);
}

function getEffortParameter(item: ModelListItem): ModelParameterDefinition | undefined {
	return getParameter(item, "effort") ?? getParameter(item, "reasoning_effort");
}

function getThinkingLevelMap(item: ModelListItem): { map: ThinkingLevelMap; requiresEffort: boolean } | undefined {
	const reasoningParameter = getParameter(item, "reasoning");
	const effortParameter = getEffortParameter(item);
	const thinkingParameter = getParameter(item, "thinking");
	const valueParameter = effortParameter ?? reasoningParameter ?? thinkingParameter;
	if (!valueParameter) return undefined;
	if (valueParameter.id === "thinking" && hasBooleanValues(valueParameter)) {
		return {
			map: {
				off: getParameterValue(valueParameter, "false"),
				minimal: null,
				low: null,
				medium: null,
				high: getParameterValue(valueParameter, "true"),
				xhigh: null,
				max: null,
			},
			requiresEffort: false,
		};
	}
	const map: ThinkingLevelMap = {
		off:
			getParameterValue(reasoningParameter, "none") ??
			getParameterValue(reasoningParameter, "off") ??
			getParameterValue(effortParameter, "none") ??
			getParameterValue(effortParameter, "off") ??
			getParameterValue(thinkingParameter, "false"),
		minimal: mapComparableLevel(valueParameter, Effort.Minimal),
		low: mapComparableLevel(valueParameter, Effort.Low),
		medium: mapComparableLevel(valueParameter, Effort.Medium),
		high: mapComparableLevel(valueParameter, Effort.High),
		xhigh: mapComparableLevel(valueParameter, Effort.XHigh),
		max: mapComparableLevel(valueParameter, Effort.Max),
	};
	let requiresEffort = false;
	if (map.off == null) {
		const effortId = effortParameter?.id ?? (valueParameter.id === "reasoning" ? valueParameter.id : undefined);
		if (effortId) {
			const variants = item.variants ?? [];
			const omitsEffort = variants.length > 0 && variants.some(
				(variant) => !(variant.params ?? []).some((param) => param.id === effortId),
			);
			if (omitsEffort) {
				map.off = "";
			} else {
				let floor: string | null = null;
				for (const effort of OMP_THINKING_EFFORTS) {
					const value = map[effort];
					if (value != null) {
						floor = value;
						break;
					}
				}
				if (floor != null) {
					map.off = floor;
					requiresEffort = true;
				}
			}
		}
	}
	return { map, requiresEffort };
}

function getSupportedThinkingEfforts(thinkingLevelMap: ThinkingLevelMap | undefined): Effort[] {
	if (!thinkingLevelMap) return [];
	return OMP_THINKING_EFFORTS.filter((effort) => thinkingLevelMap[effort] != null);
}

function getDefaultParams(item: ModelListItem): ModelParameterValue[] {
	if (!item.variants?.length) return [];
	const defaultVariant = item.variants.find((variant) => variant.isDefault) ?? item.variants[0];
	return cloneParams(defaultVariant?.params ?? []);
}

function replaceParam(params: ModelParameterValue[], id: string, value: string): ModelParameterValue[] {
	let replaced = false;
	const next = params.map((param) => {
		if (param.id !== id) return { ...param };
		replaced = true;
		return { id, value };
	});
	if (!replaced) next.push({ id, value });
	return next;
}

function getParamValue(params: ModelParameterValue[], id: string): string | undefined {
	return params.find((param) => param.id === id)?.value;
}

function setParam(params: ModelParameterValue[], id: string, value: string): void {
	const existing = params.find((param) => param.id === id);
	if (existing) existing.value = value;
	else params.push({ id, value });
}

function deleteParam(params: ModelParameterValue[], id: string): void {
	const index = params.findIndex((param) => param.id === id);
	if (index >= 0) params.splice(index, 1);
}

function toMetadata(identity: SelectionIdentity, defaultParams: ModelParameterValue[]): CursorModelMetadata {
	const { model, context, contextTiers, piModelId } = identity;
	const thinking = getThinkingLevelMap(model);
	const thinkingLevelMap = thinking?.map;
	const supportedThinkingEfforts = getSupportedThinkingEfforts(thinkingLevelMap);
	const effortParameter = getEffortParameter(model);
	const effectiveContext = context ?? contextTiers?.extended.value ?? getParamValue(defaultParams, "context");
	const fastValue = getParamValue(defaultParams, "fast")?.toLowerCase();
	const extendedContext = contextTiers
		? {
				standardValue: contextTiers.standard.value,
				extendedValue: contextTiers.extended.value,
				standardContextWindow: contextTiers.standard.contextWindow,
			}
		: undefined;
	return {
		source: "sdk",
		piModelId,
		baseModelId: model.id,
		displayName: model.displayName || model.id,
		defaultParams: cloneParams(defaultParams),
		...(context ? { context } : {}),
		...(extendedContext ? { extendedContext } : {}),
		contextWindow: advertisedContextWindow(model.id, effectiveContext, contextTiers?.extended.contextWindow),
		supportsFast: getParameter(model, "fast") !== undefined,
		defaultFast: fastValue === "true",
		supportsReasoning: supportedThinkingEfforts.length > 0,
		...(thinking?.requiresEffort ? { requiresEffort: true } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(effortParameter ? { effortParameterId: effortParameter.id } : {}),
		parameterIds: {
			context: getParameter(model, "context") !== undefined,
			reasoning: getParameter(model, "reasoning") !== undefined,
			effort: getEffortParameter(model) !== undefined,
			thinking: getParameter(model, "thinking") !== undefined,
			fast: getParameter(model, "fast") !== undefined,
		},
	};
}

function getReferencePriceModel(modelId: string) {
	for (const provider of PRICE_PROVIDERS) {
		const id = provider === "anthropic" && Object.hasOwn(CLAUDE_PRICE_IDS, modelId)
			? CLAUDE_PRICE_IDS[modelId]!
			: modelId;
		const model = getBundledModel(provider, id);
		if (!model) continue;
		let valid = true;
		let nonzero = false;
		for (const field of BASE_PRICE_FIELDS) {
			const rate = model.cost[field];
			if (!Number.isFinite(rate) || rate < 0) {
				valid = false;
				break;
			}
			if (rate > 0) nonzero = true;
		}
		if (valid && nonzero) return model;
	}
	return undefined;
}

function toModelConfig(metadata: CursorModelMetadata, name: string): ProviderModelConfig & {
	maxContextWindow?: number;
	omitMaxOutputTokens: true;
} {
	const reference = getReferencePriceModel(metadata.baseModelId);
	const { input, output, cacheRead, cacheWrite } = reference?.cost ?? ZERO_COST;
	const cost: ModelCost = { input, output, cacheRead, cacheWrite };
	if (metadata.extendedContext) {
		// Base-mode reference only: preserve the SDK threshold, not the vendor's tier pricing.
		cost.longContext = { ...cost, inputThreshold: metadata.extendedContext.standardContextWindow };
	}
	// OMP 18.3 finalizeCustomModel copies omitMaxOutputTokens and drops maxContextWindow
	// on dynamic rows. Advertising the extended window here keeps selection and budget
	// intact; the long-context threshold is what OMP caps when extended context is off.
	const extendedWindow = metadata.extendedContext ? metadata.contextWindow : undefined;
	return {
		id: metadata.piModelId,
		name,
		reasoning: metadata.supportsReasoning,
		...(metadata.supportsReasoning && metadata.thinkingLevelMap
			? {
				thinking: {
					mode: "effort" as const,
					efforts: getSupportedThinkingEfforts(metadata.thinkingLevelMap),
					...(metadata.requiresEffort ? { requiresEffort: true } : {}),
				},
			}
			: {}),
		input: [...TEXT_AND_IMAGE_INPUT],
		cost,
		contextWindow: metadata.contextWindow,
		...(extendedWindow !== undefined ? { maxContextWindow: extendedWindow } : {}),
		maxTokens: FALLBACK_MAX_TOKENS,
		omitMaxOutputTokens: true,
	};
}

function getModelName(item: Pick<ModelListItem, "id" | "displayName">, context?: string): string {
	const displayName = item.displayName || item.id;
	return context ? `${displayName} @ ${context}` : displayName;
}

function projectItems(items: readonly ModelListItem[], source: CursorModelMetadata["source"] = "sdk"): {
	metadata: Map<string, CursorModelMetadata>;
	models: ProviderModelConfig[];
} {
	const metadata = new Map<string, CursorModelMetadata>();
	const models: ProviderModelConfig[] = [];
	for (const identity of getCursorModelSelectionIdentities(items)) {
		const defaultParams = getDefaultParams(identity.model);
		const params = identity.context ? replaceParam(defaultParams, "context", identity.context) : defaultParams;
		const row = toMetadata(identity, params);
		row.source = source;
		metadata.set(identity.piModelId, row);
		models.push(toModelConfig(row, getModelName(identity.model, identity.context)));
	}
	return { metadata, models };
}

function composerFallbackMap(): Map<string, CursorModelMetadata> {
	composerFallbackMetadata ??= projectItems([COMPOSER_FALLBACK_ITEM], "fallback").metadata;
	return composerFallbackMetadata;
}

function registerModelItems(items: readonly ModelListItem[], key?: string, source: CursorModelMetadata["source"] = "sdk"): ProviderModelConfig[] {
	const projected = projectItems(items, source);
	if (key) {
		catalogsByCredential.set(key, projected.metadata);
		modelIdsByCredential.set(key, items.map((item) => item.id));
		publishLocalModelCatalog();
	}
	state = { key, metadata: projected.metadata };
	return projected.models;
}

/**
 * The SDK re-fetches `/v1/models` inside every `Agent.create`/`Agent.resume` to validate the
 * selection unless this env var supplies the catalog. Only ids matter for that check, so publish
 * the union of ids known for every credential; `buildModelSelection` already validates per credential.
 */
function publishLocalModelCatalog(): void {
	const ids = new Set<string>();
	for (const list of modelIdsByCredential.values()) for (const id of list) ids.add(id);
	const next = JSON.stringify([...ids].map((id) => ({ id })));
	const current = process.env[LOCAL_MODEL_CATALOG_ENV];
	if (current && current !== ownedLocalCatalogJson) return;
	ownedLocalCatalogJson = next;
	process.env[LOCAL_MODEL_CATALOG_ENV] = next;
}

function clearOwnedLocalCatalog(): void {
	if (process.env[LOCAL_MODEL_CATALOG_ENV] === ownedLocalCatalogJson) {
		delete process.env[LOCAL_MODEL_CATALOG_ENV];
	}
	ownedLocalCatalogJson = undefined;
}

function hydrateFallbackIfEmpty(): void {
	if (state.metadata.size > 0) return;
	state = { key: undefined, metadata: composerFallbackMap() };
}

function metadataFor(apiKey?: string): Map<string, CursorModelMetadata> {
	if (apiKey) {
		const catalog = catalogsByCredential.get(credentialScopeId(apiKey));
		if (catalog && catalog.size > 0) return catalog;
		return composerFallbackMap();
	}
	hydrateFallbackIfEmpty();
	return state.metadata;
}

function lookupMetadata(id: string, apiKey?: string): CursorModelMetadata | undefined {
	const catalog = metadataFor(apiKey);
	const prefix = `${CURSOR_SDK_PROVIDER_ID}/`;
	return catalog.get(id) ?? (id.startsWith(prefix) ? catalog.get(id.slice(prefix.length)) : undefined);
}

function applyThinkingLevel(
	metadata: CursorModelMetadata,
	params: ModelParameterValue[],
	level: ModelThinkingLevel,
): void {
	const mapped = metadata.thinkingLevelMap?.[level];
	if (mapped === undefined || mapped === null) return;
	if (level === "off") {
		if (mapped === "") {
			if (metadata.effortParameterId) deleteParam(params, metadata.effortParameterId);
			else if (metadata.parameterIds.reasoning) deleteParam(params, "reasoning");
			return;
		}
		if (metadata.parameterIds.thinking && mapped === "false") {
			setParam(params, "thinking", mapped);
			if (metadata.effortParameterId) deleteParam(params, metadata.effortParameterId);
			return;
		}
		if (metadata.parameterIds.reasoning) {
			setParam(params, "reasoning", mapped);
			return;
		}
		if (metadata.effortParameterId) {
			setParam(params, metadata.effortParameterId, mapped);
			return;
		}
		return;
	}
	if (metadata.effortParameterId) {
		if (metadata.parameterIds.thinking) setParam(params, "thinking", "true");
		setParam(params, metadata.effortParameterId, mapped);
		return;
	}
	if (metadata.parameterIds.reasoning) {
		setParam(params, "reasoning", mapped);
		return;
	}
	if (metadata.parameterIds.thinking) setParam(params, "thinking", mapped);
}

function cloneMetadata(metadata: CursorModelMetadata): CursorModelMetadata {
	return {
		...metadata,
		defaultParams: cloneParams(metadata.defaultParams),
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: { ...metadata.thinkingLevelMap } } : {}),
		...(metadata.extendedContext ? { extendedContext: { ...metadata.extendedContext } } : {}),
		parameterIds: { ...metadata.parameterIds },
	};
}

export function getModelMetadata(id: string, apiKey?: string): CursorModelMetadata | undefined {
	const metadata = lookupMetadata(id, apiKey);
	return metadata ? cloneMetadata(metadata) : undefined;
}

export function buildModelSelection(
	modelId: string,
	thinkingLevel: ModelThinkingLevel,
	options: ModelSelectionRuntimeOptions = {},
): ModelSelection {
	const metadata = lookupMetadata(modelId, options.apiKey);
	if (!metadata) {
		const source = metadataFor(options.apiKey).values().next().value?.source;
		if (source === "cache") {
			throw new Error("Cursor SDK model discovery is unavailable and the selected model has no verified cached configuration.");
		}
		if (options.apiKey && source === "sdk") {
			throw new Error(`Cursor SDK model "${modelId}" is no longer available in the live catalog. Select another cursor-sdk model or run /cursor-refresh-models.`);
		}
		return { id: modelId };
	}
	const params = cloneParams(metadata.defaultParams);
	if (metadata.extendedContext && options.extendedContextEnabled !== undefined) {
		setParam(
			params,
			"context",
			options.extendedContextEnabled ? metadata.extendedContext.extendedValue : metadata.extendedContext.standardValue,
		);
	}
	applyThinkingLevel(metadata, params, thinkingLevel);
	if (metadata.supportsFast && options.fastEnabled !== undefined) {
		setParam(params, "fast", options.fastEnabled ? "true" : "false");
	}
	const context = getParamValue(params, "context");
	if (context && isRejectedLocalContext(metadata.baseModelId, context)) {
		throw new Error(
			`Cursor Local SDK currently rejects ${metadata.baseModelId} ${context}; disable Extended Context.`,
		);
	}
	return params.length > 0 ? { id: metadata.baseModelId, params } : { id: metadata.baseModelId };
}


async function listCursorModels(apiKey: string): Promise<readonly ModelListItem[]> {
	// `return await` attaches the handler synchronously; a bare `return promise` leaves the rejection unhandled for one tick.
	return await (listModelsImpl ? listModelsImpl(apiKey) : Cursor.models.list({ apiKey }));
}

async function fetchCursorModelsUnlocked(apiKey: string): Promise<ProviderModelConfig[]> {
	try {
		const models = validatedModelItems(await listCursorModels(apiKey));
		const key = credentialScopeId(apiKey);
		const registered = registerModelItems(models, key);
		if (cacheRoot !== null && !JSON.stringify(models).includes(apiKey)) {
			await writeModelCache(cacheRoot ?? modelCacheRoot(), key, models);
		}
		return registered;
	} catch (error) {
		throw new Error(`Cursor SDK model discovery failed: ${sanitizeCursorProviderError(error, apiKey)}`);
	}
}

export async function fetchCursorModels(apiKey: string): Promise<ProviderModelConfig[]> {
	return serializeCatalogMutation(() => fetchCursorModelsUnlocked(apiKey));
}

export async function ensureCursorModels(apiKey: string): Promise<void> {
	const key = credentialScopeId(apiKey);
	await serializeCatalogMutation(async () => {
		if ((catalogsByCredential.get(key)?.size ?? 0) > 0) return;
		// Cache-first: a validated private cache serves the first turn; live discovery refreshes behind it.
		const cached = cacheRoot === null ? undefined : await readModelCache(cacheRoot ?? modelCacheRoot(), key);
		if (!cached) {
			await fetchCursorModelsUnlocked(apiKey);
			return;
		}
		registerModelItems(cached, key, "cache");
		void fetchCursorModels(apiKey).catch(() => undefined);
	});
}

export function fallbackModels(): ProviderModelConfig[] {
	const projected = projectItems([COMPOSER_FALLBACK_ITEM]);
	hydrateFallbackIfEmpty();
	return projected.models;
}

export const __testUtils = {
	parseContextWindow: parseCursorContextWindowValue,
	registerModelItems: (items: readonly ModelListItem[]) => registerModelItems(items),
	resetCatalog(): void {
		state = { key: undefined, metadata: new Map() };
		catalogsByCredential.clear();
		modelIdsByCredential.clear();
		clearOwnedLocalCatalog();
		listModelsImpl = undefined;
		catalogMutation = Promise.resolve();
		cacheRoot = null;
	},
	setListModels(fn: ListModels | undefined): void {
		listModelsImpl = fn;
	},
	setCacheRoot(root: string): void {
		cacheRoot = root;
	},
};
