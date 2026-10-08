import type { Context, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import type { GrantedTool, HostToolResult } from "./contracts.js";

export function grantedToolsFromContext(context: Context): GrantedTool[] {
	const granted: GrantedTool[] = [];
	for (const tool of context.tools ?? []) {
		if (tool.native) continue;
		const lenient = (tool as Tool & { lenientArgValidation?: boolean }).lenientArgValidation === true;
		granted.push({
			name: tool.name,
			description: descriptionFromTool(tool),
			inputSchema: schemaFromTool(tool),
			...(lenient ? { lenientArgValidation: true } : {}),
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
	const schema = toolWireSchema(tool);
	if (schema && typeof schema === "object" && schema.type === "object") return schema;
	throw new Error(`OMP tool ${tool.name} does not expose an object input schema`);
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

/**
 * `toolResult` then trailing `developer` messages are passive context.
 * A pure tool-result suffix stays resumable; developers alone are not a tool exchange.
 */
export function trailingToolExchange(context: Context): { results: ToolResultMessage[]; passive: Context["messages"] } {
	const messages = context.messages;
	let end = messages.length;
	const passive: Context["messages"] = [];
	while (end > 0 && messages[end - 1]?.role === "developer") {
		passive.unshift(messages[end - 1]!);
		end -= 1;
	}
	const results: ToolResultMessage[] = [];
	while (end > 0 && messages[end - 1]?.role === "toolResult") {
		results.unshift(messages[end - 1] as ToolResultMessage);
		end -= 1;
	}
	if (passive.length === 0 || results.length === 0) return { results: trailingToolResults(context), passive: [] };
	return { results, passive };
}

export function toolResultToHost(result: ToolResultMessage): HostToolResult {
	const content: HostToolResult["content"] = [];
	for (const block of result.content) {
		if (block.type === "text") content.push({ type: "text", text: block.text });
		if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return result.details === undefined
		? { isError: result.isError, content }
		: { isError: result.isError, content, details: result.details };
}
