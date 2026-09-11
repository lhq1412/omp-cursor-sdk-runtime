import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveCursorApiKey } from "./auth.js";
import { ensureCursorModels, fallbackModels, getModelMetadata } from "./catalog.js";
import { CURSOR_API_KEY_ENV_VAR, CURSOR_SDK_PROVIDER_ID } from "./constants.js";
import { sanitizeCursorProviderError } from "./errors.js";
import { getCursorSessionOwner, ownerForContext, sessionEvents, withCursorSessionOwner, type CursorSessionOwner } from "./session-scope.js";

const FAST_ENTRY_TYPE = "cursor-fast-state";
const FAST_USAGE = "Usage: /cursor-fast [on|off|status]";
const FAILED_LIVE_REFRESH = "live catalog refresh failed; previous models retained";

type FastMetadata = {
	baseModelId: string;
	supportsFast: boolean;
};

type ControlsApi = Pick<ExtensionAPI, "getFlag" | "appendEntry">;


interface ControlsState {
	sessionFastPreferences: Map<string, boolean>;
	controlsApi?: ControlsApi;
	lastDynamicFetch?: { ok: boolean; error?: string };
}
const states = new WeakMap<CursorSessionOwner, ControlsState>();
function controlsState(): ControlsState {
	const owner = getCursorSessionOwner();
	let state = states.get(owner);
	if (!state) {
		state = { sessionFastPreferences: new Map() };
		states.set(owner, state);
	}
	return state;
}
let metadataLookup: (id: string, apiKey?: string) => FastMetadata | undefined = lookupCatalogMetadata;

/** OMP can swallow discovery failures and return cached rows from refreshProvider. */
export function recordDynamicModelFetch(ok: boolean, error?: string): void {
	controlsState().lastDynamicFetch = { ok, error: error === undefined ? undefined : sanitizeCursorProviderError(error) };
}

function lookupCatalogMetadata(id: string, apiKey?: string): FastMetadata | undefined {
	return getModelMetadata(id, apiKey);
}

function lookupMetadata(modelId: string, apiKey?: string): FastMetadata | undefined {
	const prefix = `${CURSOR_SDK_PROVIDER_ID}/`;
	const bare = modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
	return metadataLookup(bare, apiKey) ?? metadataLookup(modelId, apiKey);
}

interface FastResolution {
	value: boolean;
	source: "no-fast" | "fast" | "session" | "default";
}

function resolveFast(baseModelId: string): FastResolution {
	const { controlsApi, sessionFastPreferences } = controlsState();
	if (controlsApi?.getFlag("cursor-no-fast") === true) return { value: false, source: "no-fast" };
	if (controlsApi?.getFlag("cursor-fast") === true) return { value: true, source: "fast" };
	if (sessionFastPreferences.has(baseModelId)) {
		return { value: sessionFastPreferences.get(baseModelId) === true, source: "session" };
	}
	return { value: false, source: "default" };
}

/** Effective fast preference for a canonical model id. CLI flags beat session state; default false. */
export function getFastMode(baseModelId: string): boolean {
	if (!baseModelId) return false;
	return resolveFast(baseModelId).value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}


function readFastEntry(data: unknown): { modelId: string; fast: boolean } | undefined {
	const record = asRecord(data);
	if (typeof record?.fast !== "boolean") return undefined;
	const modelId = typeof record.modelId === "string" ? record.modelId : "";
	if (!modelId) return undefined;
	return { modelId, fast: record.fast };
}

function foldSessionPreferences(ctx: Pick<ExtensionContext, "sessionManager">): void {
	const { sessionFastPreferences } = controlsState();
	sessionFastPreferences.clear();
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== FAST_ENTRY_TYPE) continue;
		const parsed = readFastEntry(entry.data);
		if (parsed) sessionFastPreferences.set(parsed.modelId, parsed.fast);
	}
}

function persistFastPreference(modelId: string, fast: boolean): void {
	const { controlsApi, sessionFastPreferences } = controlsState();
	if (!controlsApi) throw new Error("Cursor model controls are not registered");
	const previous = sessionFastPreferences.has(modelId) ? sessionFastPreferences.get(modelId) : undefined;
	sessionFastPreferences.set(modelId, fast);
	try {
		controlsApi.appendEntry(FAST_ENTRY_TYPE, { modelId, fast });
	} catch (error) {
		if (previous === undefined) sessionFastPreferences.delete(modelId);
		else sessionFastPreferences.set(modelId, previous);
		throw error;
	}
}

function modelLabel(model: { id: string; provider?: string } | undefined): string {
	if (!model) return "the current model";
	return model.provider ? `${model.provider}/${model.id}` : model.id;
}

async function resolveRegistryApiKey(
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<string | undefined> {
	const key = await ctx.modelRegistry.getApiKeyForProvider(CURSOR_SDK_PROVIDER_ID);
	return resolveCursorApiKey(key === "N/A" ? undefined : key) ?? resolveCursorApiKey(process.env[CURSOR_API_KEY_ENV_VAR]);
}

async function hydrateCatalogMetadata(
	ctx: Pick<ExtensionCommandContext, "model" | "modelRegistry">,
): Promise<string | undefined> {
	const model = ctx.model;
	if (!model || model.provider !== CURSOR_SDK_PROVIDER_ID) return undefined;

	fallbackModels();
	const apiKey = await resolveRegistryApiKey(ctx);
	if (lookupMetadata(model.id, apiKey)) return apiKey;

	if (apiKey) {
		try {
			await ensureCursorModels(apiKey);
		} catch {
			fallbackModels();
		}
	}
	if (!lookupMetadata(model.id, apiKey)) fallbackModels();
	return apiKey;
}

function currentFastTarget(
	ctx: Pick<ExtensionCommandContext, "model">,
	apiKey?: string,
): { ok: true; metadata: FastMetadata } | { ok: false; message: string } {
	const model = ctx.model;
	if (!model) return { ok: false, message: "Select a cursor-sdk model before using /cursor-fast." };
	if (model.provider !== CURSOR_SDK_PROVIDER_ID) {
		return { ok: false, message: `Fast mode is only available for ${CURSOR_SDK_PROVIDER_ID} models (${modelLabel(model)}).` };
	}
	const metadata = lookupMetadata(model.id, apiKey);
	if (metadata) {
		if (!metadata.supportsFast) {
			return { ok: false, message: `Fast mode is not supported by ${modelLabel(model)}.` };
		}
		return { ok: true, metadata };
	}
	return { ok: false, message: "Model capabilities are unavailable. Configure CURSOR_API_KEY and run /cursor-refresh-models first." };
}

function formatFastStatus(resolution: FastResolution): string {
	const label = resolution.value ? "on" : "off";
	if (resolution.source === "no-fast") return `Cursor fast is ${label} (--cursor-no-fast).`;
	if (resolution.source === "fast") return `Cursor fast is ${label} (--cursor-fast).`;
	return `Cursor fast is ${label}.`;
}



export function registerModelControls(
	pi: Pick<ExtensionAPI, "registerFlag" | "registerCommand" | "getFlag" | "appendEntry" | "on">,
): void {
	let preferenceGeneration = 0;
	const controlsApi: ControlsApi = {
		getFlag: (name) => pi.getFlag(name),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	};
	const on = sessionEvents(pi);
	fallbackModels();

	pi.registerFlag("cursor-fast", {
		description: "Force Cursor fast mode on for this run when the selected cursor-sdk model supports it",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("cursor-no-fast", {
		description: "Force Cursor fast mode off for this run when the selected cursor-sdk model supports it",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("cursor-fast", {
		description: "Set Cursor fast mode for the selected canonical cursor-sdk model: on, off, or status",
		handler: async (args, ctx) => withCursorSessionOwner(ownerForContext(ctx), async () => {
			controlsState().controlsApi = controlsApi;
			const normalized = args.trim().toLowerCase();
			const action = normalized === "" || normalized === "status" ? "status" : normalized;
			if (action !== "on" && action !== "off" && action !== "status") {
				ctx.ui.notify(`Invalid Cursor fast argument. ${FAST_USAGE}`, "error");
				return;
			}
			const generation = preferenceGeneration;
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionFile = ctx.sessionManager.getSessionFile();
			const model = ctx.model ? { ...ctx.model } : undefined;
			let apiKey: string | undefined;
			try {
				apiKey = await hydrateCatalogMetadata({ model, modelRegistry: ctx.modelRegistry });
			} catch (error) {
				ctx.ui.notify(`Failed to load Cursor model capabilities: ${sanitizeCursorProviderError(error, apiKey)}`, "error");
				return;
			}
			if (
				generation !== preferenceGeneration ||
				sessionId !== ctx.sessionManager.getSessionId() ||
				sessionFile !== ctx.sessionManager.getSessionFile()
			) return;
			const target = currentFastTarget({ model }, apiKey);
			if (!target.ok) {
				ctx.ui.notify(sanitizeCursorProviderError(target.message, apiKey), "error");
				return;
			}
			const resolution = resolveFast(target.metadata.baseModelId);
			if (action === "status") {
				ctx.ui.notify(formatFastStatus(resolution), "info");
				return;
			}
			if (resolution.source === "no-fast" || resolution.source === "fast") {
				ctx.ui.notify(formatFastStatus(resolution), "error");
				return;
			}
			const next = action === "on";
			try {
				persistFastPreference(target.metadata.baseModelId, next);
			} catch (error) {
				ctx.ui.notify(`Failed to save Cursor fast preference: ${sanitizeCursorProviderError(error, apiKey)}`, "error");
				return;
			}
			ctx.ui.notify(`Cursor fast ${next ? "enabled" : "disabled"}.`, "info");
		}),
	});

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh the live Cursor SDK model catalog through OMP",
		handler: async (_args, ctx) => withCursorSessionOwner(ownerForContext(ctx), async () => {
			const state = controlsState();
			state.lastDynamicFetch = undefined;
			let apiKey: string | undefined;
			try {
				apiKey = await resolveRegistryApiKey(ctx);
				if (!apiKey) {
					ctx.ui.notify("Set CURSOR_API_KEY or use /login cursor-sdk before refreshing models.", "error");
					return;
				}
				await ctx.modelRegistry.refreshProvider(CURSOR_SDK_PROVIDER_ID, "online");
				const outcome = state.lastDynamicFetch as { ok: boolean; error?: string } | undefined;
				if (!outcome?.ok) {
					ctx.ui.notify(`Failed to refresh Cursor SDK models: ${sanitizeCursorProviderError(outcome?.error ?? FAILED_LIVE_REFRESH, apiKey)}`, "error");
					return;
				}
				ctx.ui.notify("Cursor SDK model catalog refreshed.", "info");
			} catch (error) {
				ctx.ui.notify(`Failed to refresh Cursor SDK models: ${sanitizeCursorProviderError(error, apiKey)}`, "error");
			}
		}),
	});

	const invalidate = () => {
		preferenceGeneration++;
	};
	on("session_before_switch", invalidate);
	on("session_before_branch", invalidate);
	on("session_before_tree", invalidate);
	const fold = (_event: unknown, ctx: ExtensionContext) => {
		preferenceGeneration++;
		controlsState().controlsApi = controlsApi;
		foldSessionPreferences(ctx);
	};
	on("session_start", fold);
	on("session_switch", fold);
	on("session_branch", fold);
	on("session_tree", fold);
}

export const __testUtils = {
	FAST_ENTRY_TYPE,
	get sessionFastPreferences() { return controlsState().sessionFastPreferences; },
	setMetadataLookup(lookup: (id: string, apiKey?: string) => FastMetadata | undefined): void {
		metadataLookup = lookup;
	},
	reset(): void {
		states.delete(getCursorSessionOwner());
		metadataLookup = lookupCatalogMetadata;
		controlsState().lastDynamicFetch = undefined;
	},
};
