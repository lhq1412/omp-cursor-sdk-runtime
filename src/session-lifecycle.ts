import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CURSOR_SDK_PROVIDER_ID } from "./constants.js";
import { summaryCoversMessages } from "./context.js";
import { getCursorSessionOwner, getCursorSessionScopeKey, sessionEvents } from "./session-scope.js";
import { disposeRuntimeForScope, disposeRuntimeForShutdown, invalidateRuntime } from "./session-runtime.js";

export interface CursorPortableSummary {
	text: string;
	agentId: string;
	rootBlobId: string;
	sourceContextFingerprint: string;
	generation: number;
	occupancyAfter?: number;
}

// ponytail: process-local; persist with resume JSONL if portable summaries must survive restart.
const portableSummaries = new Map<string, CursorPortableSummary>();

export function rememberPortableSummary(summary: CursorPortableSummary, scopeKey = getCursorSessionScopeKey()): void {
	if (!summary.text) return;
	portableSummaries.set(scopeKey, summary);
}

function clearPortableSummary(scopeKey = getCursorSessionScopeKey()): void {
	portableSummaries.delete(scopeKey);
}

export function registerCursorSessionLifecycle(pi: Pick<ExtensionAPI, "on">): void {
	const on = sessionEvents(pi);
	const autoCompacting = new Set<string>();
	const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
	const closeScope = async () => {
		getCursorSessionOwner().generation++;
		clearPortableSummary();
		await disposeRuntimeForScope();
	};
	on("session_shutdown", async () => {
		getCursorSessionOwner().generation++;
		clearPortableSummary();
		await disposeRuntimeForShutdown();
	});
	on("session_compact", () => {
		getCursorSessionOwner().generation++;
		clearPortableSummary();
		invalidateRuntime("session_compact");
	});
	on("session_before_tree", () => {
		getCursorSessionOwner().generation++;
		invalidateRuntime("session_before_tree");
	});
	on("session_before_switch", closeScope);
	on("session_before_branch", closeScope);
	on("session_tree", closeScope);
	// ponytail: session_before_compact registration disables OMP speculative compaction for every provider.
	on("auto_compaction_start", (_event, ctx) => {
		if (ctx.model?.provider !== CURSOR_SDK_PROVIDER_ID) return;
		const id = sessionId(ctx);
		if (id) autoCompacting.add(id);
	});
	on("session_before_compact", (event, ctx) => {
		const id = sessionId(ctx);
		if (id && ctx.model?.provider === CURSOR_SDK_PROVIDER_ID && autoCompacting.has(id)) return { cancel: true };
		if (ctx.model?.provider === CURSOR_SDK_PROVIDER_ID) return;
		const summary = portableSummaries.get(getCursorSessionScopeKey());
		const preparation = event.preparation;
		if (!summary || !preparation || summary.generation !== getCursorSessionOwner().generation) return;
		if (!summaryCoversMessages(summary.sourceContextFingerprint, preparation.messagesToSummarize)) return;
		return {
			compaction: {
				summary: summary.text,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				preserveData: {
					cursorSdkPortableSummary: {
						generation: summary.generation,
						occupancyAfter: summary.occupancyAfter,
					},
				},
			},
		};
	});
	on("auto_compaction_end", (_event, ctx) => {
		const id = sessionId(ctx);
		if (id) autoCompacting.delete(id);
	});
}

export const __testUtils = {
	remember: rememberPortableSummary,
	clear: () => portableSummaries.clear(),
};
