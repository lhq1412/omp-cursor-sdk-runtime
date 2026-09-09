import {
	Cursor,
	type ModelListItem,
	type ModelParameterDefinition,
	type ModelParameterValue,
	type ModelSelection,
} from "@cursor/sdk";
import { Effort, type ModelCost } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { credentialScopeId } from "./auth.js";
import { CURSOR_SDK_PROVIDER_ID, DEFAULT_MODEL_ID } from "./constants.js";

export type ModelThinkingLevel = "off" | Effort;
type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export interface CursorModelMetadata {
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
	thinkingLevelMap?: ThinkingLevelMap;
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
let listModelsImpl: ListModels | undefined;
let catalogMutation: Promise<void> = Promise.resolve();
let composerFallbackMetadata: Map<string, CursorModelMetadata> | undefined;

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

function getThinkingLevelMap(item: ModelListItem): ThinkingLevelMap | undefined {
	const reasoningParameter = getParameter(item, "reasoning");
	const effortParameter = getParameter(item, "effort");
	const thinkingParameter = getParameter(item, "thinking");
	const valueParameter = effortParameter ?? reasoningParameter ?? thinkingParameter;
	if (!valueParameter) return undefined;
	if (valueParameter.id === "thinking" && hasBooleanValues(valueParameter)) {
		return {
			off: getParameterValue(valueParameter, "false"),
			minimal: null,
			low: null,
			medium: null,
			high: getParameterValue(valueParameter, "true"),
			xhigh: null,
			max: null,
		};
	}
	return {
		off:
			getParameterValue(reasoningParameter, "none") ??
			getParameterValue(reasoningParameter, "off") ??
			getParameterValue(thinkingParameter, "false"),
		minimal: mapComparableLevel(valueParameter, Effort.Minimal),
		low: mapComparableLevel(valueParameter, Effort.Low),
		medium: mapComparableLevel(valueParameter, Effort.Medium),
		high: mapComparableLevel(valueParameter, Effort.High),
		xhigh: mapComparableLevel(valueParameter, Effort.XHigh),
		max: mapComparableLevel(valueParameter, Effort.Max),
	};
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

function contextWindowFor(context: string | undefined, fallback: number): number {
	return (context ? parseCursorContextWindowValue(context) : undefined) ?? fallback;
}

function toMetadata(identity: SelectionIdentity, defaultParams: ModelParameterValue[]): CursorModelMetadata {
	const { model, context, contextTiers, piModelId } = identity;
	const thinkingLevelMap = getThinkingLevelMap(model);
	const supportedThinkingEfforts = getSupportedThinkingEfforts(thinkingLevelMap);
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
		piModelId,
		baseModelId: model.id,
		displayName: model.displayName || model.id,
		defaultParams: cloneParams(defaultParams),
		...(context ? { context } : {}),
		...(extendedContext ? { extendedContext } : {}),
		contextWindow: contextTiers?.extended.contextWindow ?? contextWindowFor(effectiveContext, FALLBACK_CONTEXT_WINDOW),
		supportsFast: getParameter(model, "fast") !== undefined,
		defaultFast: fastValue === "true",
		supportsReasoning: supportedThinkingEfforts.length > 0,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		parameterIds: {
			context: getParameter(model, "context") !== undefined,
			reasoning: getParameter(model, "reasoning") !== undefined,
			effort: getParameter(model, "effort") !== undefined,
			thinking: getParameter(model, "thinking") !== undefined,
			fast: getParameter(model, "fast") !== undefined,
		},
	};
}

function toModelConfig(metadata: CursorModelMetadata, name: string): ProviderModelConfig {
	const cost: ModelCost = metadata.extendedContext
		? {
				...ZERO_COST,
				longContext: {
					...ZERO_COST,
					inputThreshold: metadata.extendedContext.standardContextWindow,
				},
			}
		: { ...ZERO_COST };
	return {
		id: metadata.piModelId,
		name,
		reasoning: metadata.supportsReasoning,
		...(metadata.supportsReasoning && metadata.thinkingLevelMap
			? {
					thinking: {
						mode: "effort",
						efforts: getSupportedThinkingEfforts(metadata.thinkingLevelMap),
					},
				}
			: {}),
		input: [...TEXT_AND_IMAGE_INPUT],
		cost,
		contextWindow: metadata.contextWindow,
		maxTokens: FALLBACK_MAX_TOKENS,
	};
}

function getModelName(item: Pick<ModelListItem, "id" | "displayName">, context?: string): string {
	const displayName = item.displayName || item.id;
	return context ? `${displayName} @ ${context}` : displayName;
}

function projectItems(items: readonly ModelListItem[]): {
	metadata: Map<string, CursorModelMetadata>;
	models: ProviderModelConfig[];
} {
	const metadata = new Map<string, CursorModelMetadata>();
	const models: ProviderModelConfig[] = [];
	for (const identity of getCursorModelSelectionIdentities(items)) {
		const defaultParams = getDefaultParams(identity.model);
		const params = identity.context ? replaceParam(defaultParams, "context", identity.context) : defaultParams;
		const row = toMetadata(identity, params);
		metadata.set(identity.piModelId, row);
		models.push(toModelConfig(row, getModelName(identity.model, identity.context)));
	}
	return { metadata, models };
}

function composerFallbackMap(): Map<string, CursorModelMetadata> {
	composerFallbackMetadata ??= projectItems([COMPOSER_FALLBACK_ITEM]).metadata;
	return composerFallbackMetadata;
}

function registerModelItems(items: readonly ModelListItem[], key?: string): ProviderModelConfig[] {
	const projected = projectItems(items);
	if (key) catalogsByCredential.set(key, projected.metadata);
	state = { key, metadata: projected.metadata };
	return projected.models;
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
		if (metadata.parameterIds.thinking && mapped === "false") {
			setParam(params, "thinking", mapped);
			deleteParam(params, "effort");
			return;
		}
		if (metadata.parameterIds.reasoning) {
			setParam(params, "reasoning", mapped);
			return;
		}
		return;
	}
	if (metadata.parameterIds.effort) {
		if (metadata.parameterIds.thinking) setParam(params, "thinking", "true");
		setParam(params, "effort", mapped);
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
	if (!metadata) return { id: modelId };
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
	return params.length > 0 ? { id: metadata.baseModelId, params } : { id: metadata.baseModelId };
}

function sanitizeDiscoveryError(error: unknown, apiKey: string): Error {
	const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const detail = raw.split(apiKey).join("<redacted>").trim();
	return new Error(`Cursor SDK model discovery failed${detail ? `: ${detail}` : "."}`);
}

async function listCursorModels(apiKey: string): Promise<readonly ModelListItem[]> {
	return listModelsImpl ? listModelsImpl(apiKey) : Cursor.models.list({ apiKey });
}

async function fetchCursorModelsUnlocked(apiKey: string): Promise<ProviderModelConfig[]> {
	try {
		const models = await listCursorModels(apiKey);
		if (models.length === 0) {
			throw new Error("empty model catalog");
		}
		return registerModelItems(models, credentialScopeId(apiKey));
	} catch (error) {
		throw sanitizeDiscoveryError(error, apiKey);
	}
}

export async function fetchCursorModels(apiKey: string): Promise<ProviderModelConfig[]> {
	return serializeCatalogMutation(() => fetchCursorModelsUnlocked(apiKey));
}

export async function ensureCursorModels(apiKey: string): Promise<void> {
	const key = credentialScopeId(apiKey);
	await serializeCatalogMutation(async () => {
		if ((catalogsByCredential.get(key)?.size ?? 0) > 0) return;
		await fetchCursorModelsUnlocked(apiKey);
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
		listModelsImpl = undefined;
		catalogMutation = Promise.resolve();
	},
	setListModels(fn: ListModels | undefined): void {
		listModelsImpl = fn;
	},
};
