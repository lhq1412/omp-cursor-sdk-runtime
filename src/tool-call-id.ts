import { createHash } from "node:crypto";

function isPortableToolCallId(id: string): boolean {
	const sanitized = id.replace(/[^A-Za-z0-9_-]/g, "_");
	return (sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized) === id;
}

/** Cursor SDK → OMP portable tool-call ID. Already-portable IDs are kept. */
export function projectSdkToolCallId(id: string): string {
	if (isPortableToolCallId(id)) return id;
	return createHash("sha256").update("cursor-sdk:omp-tool-call\0").update(id).digest("hex");
}

/** OMP history ID → Cursor native checkpoint ID. */
export function nativeToolCallId(id: string): string {
	return createHash("sha256").update("omp-native-history:tool-call\0").update(id).digest("hex");
}
