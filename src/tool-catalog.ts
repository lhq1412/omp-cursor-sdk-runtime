import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Tool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type { GrantedTool } from "./contracts.js";

const OPEN_SCHEMA: Record<string, unknown> = { type: "object", additionalProperties: true };

const extras = new Map<string, GrantedTool>();
let liveCatalog: (() => readonly (string | CatalogToolInfo)[]) | undefined;

export function isMcpToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

function extraDescription(name: string, description?: string): string {
	const base = description?.trim() || name;
	if (isMcpToolName(name)) {
		return `${base} (OMP MCP tool ${name})`;
	}
	return `${base} (OMP xd:// device ${name})`;
}

function schemaFromParameters(parameters: unknown): Record<string, unknown> {
	if (!parameters || typeof parameters !== "object") return OPEN_SCHEMA;
	try {
		const schema = toolWireSchema({
			name: "catalog",
			description: "",
			parameters: parameters as Tool["parameters"],
		} as Tool);
		if (schema && typeof schema === "object" && schema.type === "object") return schema;
	} catch {
		// Fall through.
	}
	const record = parameters as Record<string, unknown>;
	if (record.type === "object") return record;
	return OPEN_SCHEMA;
}

export interface CatalogToolInfo {
	name: string;
	description?: string;
	parameters?: unknown;
}

/**
 * Index every registered OMP tool. Do **not** skip `getActiveTools()`:
 * OMP's ExtensionAPI maps that to `getEnabledToolNames()`, which includes
 * xd://-mounted MCP tools that are absent from `context.tools`.
 */
export function snapshotHostToolCatalog(allTools: readonly (string | CatalogToolInfo)[]): void {
	extras.clear();
	for (const item of allTools) {
		const name = typeof item === "string" ? item : item.name;
		if (!name) continue;
		const description = typeof item === "string" ? undefined : item.description;
		const parameters = typeof item === "string" ? undefined : item.parameters;
		extras.set(name, {
			name,
			description: extraDescription(name, description),
			inputSchema: schemaFromParameters(parameters),
		});
	}
}

export function extraGrantedTools(): GrantedTool[] {
	return [...extras.values()];
}

export function mergeGrantedTools(fromContext: readonly GrantedTool[]): GrantedTool[] {
	if (liveCatalog) {
		try {
			snapshotHostToolCatalog(liveCatalog());
		} catch {
			// Catalog is best-effort; keep the last successful snapshot.
		}
	}
	const byName = new Map<string, GrantedTool>();
	for (const extra of extras.values()) {
		byName.set(extra.name, extra);
	}
	for (const tool of fromContext) {
		byName.set(tool.name, tool);
	}
	return [...byName.values()];
}

export function registerHostToolCatalog(pi: Pick<ExtensionAPI, "on" | "getAllTools">): void {
	liveCatalog = () => pi.getAllTools();
	const snapshot = () => {
		snapshotHostToolCatalog(pi.getAllTools());
	};
	pi.on("session_start", snapshot);
	pi.on("before_agent_start", snapshot);
	pi.on("turn_start", snapshot);
	pi.on("session_tree", snapshot);
}

export function toolNameHash(name: string): string {
	return createHash("sha256").update(name).digest("hex").slice(0, 8);
}

export const __testUtils = {
	clear() {
		extras.clear();
		liveCatalog = undefined;
	},
	setLiveCatalog(loader: (() => readonly (string | CatalogToolInfo)[]) | undefined) {
		liveCatalog = loader;
	},
	extras,
};
