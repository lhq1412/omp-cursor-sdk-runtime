import { createHash } from "node:crypto";
import { normalizeToolCallId } from "@oh-my-pi/pi-ai/utils";

/** Cursor SDK → OMP portable tool-call ID. Already-portable IDs are kept. */
export function projectSdkToolCallId(id: string): string {
	if (normalizeToolCallId(id) === id) return id;
	return createHash("sha256").update("cursor-sdk:omp-tool-call\0").update(id).digest("hex");
}

/** OMP history ID → Cursor native checkpoint ID. */
export function nativeToolCallId(id: string): string {
	return createHash("sha256").update("omp-native-history:tool-call\0").update(id).digest("hex");
}
