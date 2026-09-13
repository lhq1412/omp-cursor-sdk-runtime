import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { Api } from "@oh-my-pi/pi-ai";
import { CURSOR_SDK_API, CURSOR_SDK_PROVIDER_ID } from "./constants.js";
import { createEmptyAssistantMessage, createProviderStream } from "./projector.js";
import { ProviderTurnRunner } from "./provider-turn-runner.js";

export function streamCursorRuntime(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (model.provider !== CURSOR_SDK_PROVIDER_ID || model.api !== CURSOR_SDK_API) {
		throw new Error(`Provider ${CURSOR_SDK_PROVIDER_ID} only accepts ${CURSOR_SDK_API} models`);
	}
	const stream = createProviderStream();
	const partial = createEmptyAssistantMessage(model);
	queueMicrotask(() => {
		void new ProviderTurnRunner(model, context, options, stream, partial).run();
	});
	return stream;
}
