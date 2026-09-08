import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { applyInteractionUpdate, applyToolCall, createEmptyAssistantMessage } from "../../src/projector.ts";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "../../src/constants.ts";
import type { Model } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";

describe("projector", () => {
	test("accumulates text deltas without duplicating blocks", () => {
		const model = {
			id: "composer-2.5",
			provider: CURSOR_SDK_PROVIDER_ID,
			api: CURSOR_SDK_API,
		} as Model<Api>;
		const stream = createAssistantMessageEventStream();
		const partial = createEmptyAssistantMessage(model);
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "Hel" });
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "lo" });
		expect(partial.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	test("emits a closed toolCall block for OMP toolUse", () => {
		const model = {
			id: "composer-2.5",
			provider: CURSOR_SDK_PROVIDER_ID,
			api: CURSOR_SDK_API,
		} as Model<Api>;
		const stream = createAssistantMessageEventStream();
		const partial = createEmptyAssistantMessage(model);
		applyInteractionUpdate(stream, partial, { type: "text-delta", text: "Using read" });
		applyToolCall(stream, partial, { id: "call-1", name: "read", arguments: { path: "a.ts" } });
		expect(partial.content[1]).toMatchObject({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } });
	});
});
