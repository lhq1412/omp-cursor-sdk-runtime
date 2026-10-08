import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { parseImageMetadata } from "@oh-my-pi/pi-utils/mime";

/**
 * Dimension-based image budgets from the OMP 18.8 image-tokenization rules.
 * Unknown pixel size uses the rule's full budget so an unpriced image is not undercounted.
 */

interface ImageSize {
	width: number;
	height: number;
}

interface PatchSizing {
	maxEdge: number;
	patchBudget?: number;
}

type ImageTokenization =
	| { regime: "openai-patch"; multiplier: number; low: PatchSizing; high: PatchSizing; original: PatchSizing; auto: "high" | "original" }
	| { regime: "anthropic-patch"; maxEdge: number; maxTokens: number }
	| { regime: "fixed"; tokens: number };

const CURSOR_ANTHROPIC: ImageTokenization = { regime: "anthropic-patch", maxEdge: 2576, maxTokens: 4784 };
const OPENAI: ImageTokenization = {
	regime: "openai-patch",
	multiplier: 1.2,
	auto: "original",
	low: { maxEdge: 512 },
	high: { maxEdge: 2048, patchBudget: 2500 },
	original: { maxEdge: 6000, patchBudget: 10000 },
};
const GOOGLE: ImageTokenization = { regime: "fixed", tokens: 1120 };

const OPENAI_PATCH_PX = 32;
const ANTHROPIC_PATCH_PX = 28;

function fitLongEdge(size: ImageSize, maxEdge: number): ImageSize {
	const longest = Math.max(size.width, size.height);
	if (longest <= maxEdge) return size;
	const scale = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(size.width * scale)),
		height: Math.max(1, Math.round(size.height * scale)),
	};
}

function openAiPatches(size: ImageSize, sizing: PatchSizing): number {
	const { width, height } = fitLongEdge(size, sizing.maxEdge);
	const patches = Math.ceil(width / OPENAI_PATCH_PX) * Math.ceil(height / OPENAI_PATCH_PX);
	const budget = sizing.patchBudget;
	if (budget === undefined || patches <= budget) return patches;
	const shrink = Math.sqrt((OPENAI_PATCH_PX * OPENAI_PATCH_PX * budget) / (width * height));
	const scaledW = (width * shrink) / OPENAI_PATCH_PX;
	const scaledH = (height * shrink) / OPENAI_PATCH_PX;
	const adjusted = shrink * Math.min(Math.floor(scaledW) / scaledW, Math.floor(scaledH) / scaledH);
	const resizedW = Math.floor(width * adjusted);
	const resizedH = Math.floor(height * adjusted);
	if (resizedW <= 0 || resizedH <= 0) return budget;
	return Math.min(budget, Math.ceil(resizedW / OPENAI_PATCH_PX) * Math.ceil(resizedH / OPENAI_PATCH_PX));
}

function roundTiesToEven(value: number): number {
	const floor = Math.floor(value);
	if (value - floor !== 0.5) return Math.round(value);
	return floor % 2 === 0 ? floor : floor + 1;
}

function anthropicTokens(size: ImageSize, maxEdge: number, maxTokens: number): number {
	const long = Math.max(size.width, size.height);
	const shortSide = Math.min(size.width, size.height);
	const aspect = long / shortSide;
	const patches = (l: number, s: number) => Math.ceil(l / ANTHROPIC_PATCH_PX) * Math.ceil(s / ANTHROPIC_PATCH_PX);
	const fits = (l: number, s: number) =>
		Math.ceil(l / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <= maxEdge &&
		Math.ceil(s / ANTHROPIC_PATCH_PX) * ANTHROPIC_PATCH_PX <= maxEdge &&
		patches(l, s) <= maxTokens;
	const short = (l: number) => Math.max(roundTiesToEven(l / aspect), 1);
	if (fits(long, shortSide)) return patches(long, shortSide);
	let lo = 1;
	let hi = long;
	while (lo + 1 < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (fits(mid, short(mid))) lo = mid;
		else hi = mid;
	}
	return patches(lo, short(lo));
}

function imageTokens(rule: ImageTokenization, size: ImageSize): number {
	switch (rule.regime) {
		case "fixed":
			return rule.tokens;
		case "openai-patch":
			return Math.ceil(openAiPatches(size, rule[rule.auto]) * rule.multiplier);
		case "anthropic-patch":
			return anthropicTokens(size, rule.maxEdge, rule.maxTokens);
	}
}

function fullBudget(rule: ImageTokenization): number {
	switch (rule.regime) {
		case "fixed":
			return rule.tokens;
		case "anthropic-patch":
			return rule.maxTokens;
		case "openai-patch":
			return Math.ceil((rule.original.patchBudget ?? 0) * rule.multiplier);
	}
}

export function imageTokenRule(modelId?: string): ImageTokenization {
	if (!modelId) return CURSOR_ANTHROPIC;
	const identity = classifyModel("cursor", modelId, { lenient: true });
	if (identity.class === "anthropic") return CURSOR_ANTHROPIC;
	if (identity.class === "openai") return OPENAI;
	if (identity.class === "gemini") return GOOGLE;
	return CURSOR_ANTHROPIC;
}

export function imageTokenBudget(data: string, mimeType: string, modelId?: string): number {
	const rule = imageTokenRule(modelId);
	const ceiling = fullBudget(rule);
	if (!data || !mimeType.startsWith("image/")) return ceiling;
	const bytes = Buffer.from(data, "base64");
	const meta = parseImageMetadata(bytes);
	if (!meta?.width || !meta.height) return ceiling;
	return imageTokens(rule, { width: meta.width, height: meta.height });
}
