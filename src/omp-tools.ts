import type { Context, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type { GrantedTool, HostToolResult } from "./contracts.js";

export function grantedToolsFromContext(context: Context): GrantedTool[] {
	const granted: GrantedTool[] = [];
	for (const tool of context.tools ?? []) {
		if (tool.native) continue;
		granted.push({
			name: tool.name,
			description: tool.description,
			inputSchema: schemaFromTool(tool),
		});
	}
	return granted;
}

function schemaFromTool(tool: Tool): Record<string, unknown> {
	try {
		const schema = toolWireSchema(tool);
		if (schema && typeof schema === "object" && schema.type === "object") return schema;
	} catch {
		// Fall through to an open object so the tool is still advertised.
	}
	return { type: "object", additionalProperties: true };
}

export function trailingToolResults(context: Context): ToolResultMessage[] {
	const results: ToolResultMessage[] = [];
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message.role !== "toolResult") break;
		results.unshift(message);
	}
	return results;
}

export function toolResultToHost(result: ToolResultMessage): HostToolResult {
	const content: HostToolResult["content"] = [];
	for (const block of result.content) {
		if (block.type === "text") content.push({ type: "text", text: block.text });
		if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return { isError: result.isError, content };
}
