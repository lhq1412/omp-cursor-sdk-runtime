import { Cursor, type ModelListItem } from "@cursor/sdk";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID, DEFAULT_MODEL_ID } from "./constants.js";

export interface ProviderModelRow {
	id: string;
	name: string;
	api: typeof CURSOR_SDK_API;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export function projectCatalogModel(item: ModelListItem): ProviderModelRow {
	if (!item.id.trim()) {
		throw new Error("Cursor model catalog returned an empty model id");
	}
	return {
		id: item.id,
		name: item.displayName || item.id,
		api: CURSOR_SDK_API,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

export function fallbackModels(): ProviderModelRow[] {
	return [
		{
			id: DEFAULT_MODEL_ID,
			name: "Composer 2.5",
			api: CURSOR_SDK_API,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		},
	];
}

export async function fetchCursorModels(apiKey: string): Promise<ProviderModelRow[]> {
	try {
		const models = await Cursor.models.list({ apiKey });
		const projected = models.map(projectCatalogModel);
		return projected.length > 0 ? projected : fallbackModels();
	} catch {
		return fallbackModels();
	}
}

export function qualifiedModelId(id: string): string {
	return `${CURSOR_SDK_PROVIDER_ID}/${id}`;
}
