import type { Context, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type { GrantedTool, HostToolResult } from "./contracts.js";

export function grantedToolsFromContext(context: Context): GrantedTool[] {
	const granted: GrantedTool[] = [];
	for (const tool of context.tools ?? []) {
		if (tool.native) continue;
		granted.push({
			name: tool.name,
			description: descriptionFromTool(tool),
			inputSchema: schemaFromTool(tool),
		});
	}
	return granted;
}

function descriptionFromTool(tool: Tool): string {
	if (tool.description.includes("<examples>")) return tool.description;
	const examples = formatToolExamples(tool);
	if (!examples) return tool.description;
	return tool.description ? `${tool.description}\n\n${examples}` : examples;
}

function formatToolExamples(tool: Tool): string {
	const examples = tool.examples;
	if (!examples?.length) return "";
	const parts: string[] = [];
	for (const example of examples) {
		const head = example.caption ? `# ${example.caption}\n` : "";
		if ("call" in example) {
			parts.push(`${head}<example>\n${JSON.stringify(example.call)}\n</example>`);
		} else if ("good" in example) {
			parts.push(`${head}WRONG:\n${JSON.stringify(example.bad)}\nRIGHT:\n${JSON.stringify(example.good)}`);
		} else if (example.note) {
			parts.push(`${head}${example.note}`.trimEnd());
		}
	}
	return parts.length === 0 ? "" : `<examples>\n${parts.join("\n")}\n</examples>`;
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
