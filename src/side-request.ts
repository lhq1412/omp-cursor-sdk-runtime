import type { Context } from "@oh-my-pi/pi-ai";

const SIDE_CHANNEL_MARKER = "Ephemeral side-channel turn";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

/**
 * In-session `/btw` and handoff still fire `before_provider_request` on the parent,
 * so a captured parent owner is not proof the turn may execute tools or write resume state.
 */
export function isSideChannelRequest(sessionId: string | undefined, context: Context): boolean {
	if (sessionId?.includes(":side:")) return true;
	return context.messages.some((message) => message.role === "developer" && textOf(message.content).includes(SIDE_CHANNEL_MARKER));
}
