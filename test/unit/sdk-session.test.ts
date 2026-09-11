import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_NATIVE_DISALLOWED_TOOLS, SYSTEM_PROMPT_REPLACEMENT } from "../../src/constants.ts";
import { emptySendState, planSend, prepareSendInput } from "../../src/context.ts";
import { buildAgentOptions, CloudAgentRejectedError, openAgent } from "../../src/sdk-session.ts";
import { Agent, JsonlLocalAgentStore, type SDKAgent, type LocalAgentRunDocument } from "@cursor/sdk";
import type { Context } from "@oh-my-pi/pi-ai";

describe("buildAgentOptions", () => {
	const store = new JsonlLocalAgentStore("/tmp/omp-cursor-runtime-test-store");

	test("uses mcp for custom tools and disallows native executors", () => {
		const options = buildAgentOptions({
			apiKey: "test-key",
			cwd: "/tmp",
			model: { id: "composer-2.5" },
			store,
			customTools: {
				read: {
					description: "read",
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				},
			},
		});
		expect(options.tools).toEqual(["mcp"]);
		expect(options.disallowedTools).toEqual([...SDK_NATIVE_DISALLOWED_TOOLS]);
		expect(SDK_NATIVE_DISALLOWED_TOOLS).toContain("readMcpResource");
		expect(SDK_NATIVE_DISALLOWED_TOOLS).toContain("listMcpResources");
		expect(SDK_NATIVE_DISALLOWED_TOOLS).not.toContain("FetchMcpResource");
		expect(options.local?.settingSources).toEqual([]);
		expect(options.local?.enableAgentRetries).toBe(false);
		expect(options.mcpServers).toEqual({});
		expect(options.systemPrompt).toBeUndefined();
		expect(SYSTEM_PROMPT_REPLACEMENT).toBe("unsupported");
	});

	test("uses text-only tools when no custom tools are granted", () => {
		const options = buildAgentOptions({
			apiKey: "test-key",
			cwd: "/tmp",
			model: { id: "composer-2.5" },
			store,
			customTools: {},
		});
		expect(options.tools).toEqual([]);
	});

	test("rejects cloud agent ids", () => {
		expect(() =>
			buildAgentOptions({
				apiKey: "test-key",
				cwd: "/tmp",
				model: { id: "composer-2.5" },
				store,
				customTools: {},
				savedAgentId: "bc-cloud",
			}),
		).toThrow(CloudAgentRejectedError);
	});
});

describe("native history bootstrap", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	});

	function setup() {
		const root = mkdtempSync(join(tmpdir(), "omp-native-history-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const store = new JsonlLocalAgentStore(root);
		const signal = new AbortController();
		const disposed: string[] = [];
		const handle = (name: string) => ({
			agentId: "owned-agent",
			async [Symbol.asyncDispose]() { disposed.push(name); },
		}) as SDKAgent;
		let seedRun: LocalAgentRunDocument = {
			agentId: "owned-agent", runId: "owned-init", turnNumber: 1,
			status: "queued", createdAt: 1, updatedAt: 1,
		};
		const create = spyOn(Agent, "create").mockImplementation(async () => {
			await store.agents.create({ agent: {
				agentId: "owned-agent", cwd: root, status: "idle", activeRunId: "owned-init",
				createdAt: 1, updatedAt: 1, sdkMetadata: { preserved: true },
			} });
			await store.runs.create({ run: seedRun });
			return handle("seed");
		});
		const cancel = spyOn(Agent, "cancelRun").mockImplementation(async () => {
			const document = (await store.agents.get({ agentId: "owned-agent" }))!;
			await store.agents.update({ agent: { ...document, activeRunId: null } });
			await store.runs.update({ run: { ...seedRun, status: "cancelled" } });
		});
		const resume = spyOn(Agent, "resume").mockImplementation(async () => handle("resumed"));
		cleanups.push(() => create.mockRestore(), () => cancel.mockRestore(), () => resume.mockRestore());
		const input = {
			apiKey: "test-key", cwd: root, model: { id: "composer-2.5" }, store,
			customTools: {}, signal: signal.signal,
			bootstrapHistory: [{ role: "user" as const, content: "Preserve this final historical user", timestamp: 1 }],
		};
		return { input, store, signal, disposed, cancel, resume, create,
			setRun: (patch: Partial<LocalAgentRunDocument>) => { seedRun = { ...seedRun, ...patch }; } };
	}

	test("publishes a readable native graph retaining the final historical user", async () => {
		const fixture = setup();
		const agent = await openAgent(fixture.input);
		try {
			const messages = await Agent.messages.list(agent.agentId, {
				cwd: fixture.input.cwd, store: fixture.store,
			});
			expect(JSON.stringify(messages)).toContain("Preserve this final historical user");
			expect((await fixture.store.agents.get({ agentId: agent.agentId }))?.sdkMetadata).toEqual({ preserved: true });
			expect(fixture.disposed).toEqual(["seed"]);
		} finally {
			await agent[Symbol.asyncDispose]();
		}
	});

	test("keeps colliding historical call IDs distinct and paired without changing input", async () => {
		const fixture = setup();
		const history = [
			{ role: "user", content: "Read both files", timestamp: 1 },
			{
				role: "assistant", provider: "openai", model: "original-model", api: "openai-responses", timestamp: 2,
				content: [
					{ type: "toolCall", id: "call:one", name: "read", arguments: { path: "first.txt" } },
					{ type: "toolCall", id: "call_one", name: "read", arguments: { path: "second.txt" } },
				],
			},
			{ role: "toolResult", toolCallId: "call_one", toolName: "read", content: [{ type: "text", text: "second result" }], isError: false, timestamp: 3 },
			{ role: "toolResult", toolCallId: "call:one", toolName: "read", content: [{ type: "text", text: "first result" }], isError: false, timestamp: 4 },
		] as Context["messages"];
		const original = structuredClone(history);
		const agent = await openAgent({ ...fixture.input, bootstrapHistory: history });
		try {
			const messages = await Agent.messages.list(agent.agentId, { cwd: fixture.input.cwd, store: fixture.store });
			const turn = messages[0]?.message as {
				turn: { value: { steps: Array<{ message: { value: { toolCallId: string } } }> } };
			};
			const steps = turn.turn.value.steps;
			expect(steps).toHaveLength(2);
			const ids = steps.map((step) => step.message.value.toolCallId);
			expect(new Set(ids).size).toBe(2);
			for (const [index, text] of ["first result", "second result"].entries()) {
				expect(ids[index]).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
				expect(steps[index]).toMatchObject({
					message: { case: "toolCall", value: {
						tool: { case: "mcpToolCall", value: {
							args: {
								toolCallId: ids[index],
								args: { path: { kind: { case: "stringValue", value: index === 0 ? "first.txt" : "second.txt" } } },
							},
							result: { result: { case: "success", value: {
								content: [{ content: { case: "text", value: { text } } }],
							} } },
						} },
					} },
				});
			}
			expect(history).toEqual(original);
		} finally {
			await agent[Symbol.asyncDispose]();
		}
	});

	test("recovered image labels identify native calls and results in attachment order", async () => {
		const fixture = setup();
		const beforeImage = { type: "image" as const, data: Buffer.from("before-image").toString("base64"), mimeType: "image/png" };
		const afterImage = { type: "image" as const, data: Buffer.from("after-image").toString("base64"), mimeType: "image/png" };
		const context = {
			messages: [
				{ role: "user", content: "Compare the screenshots", timestamp: 1 },
				{
					role: "assistant", provider: "openai", model: "original-model", api: "openai-responses", timestamp: 2,
					content: [
						{ type: "toolCall", id: "call:one", name: "read", arguments: { path: "before.png" } },
						{ type: "toolCall", id: "call_one", name: "read", arguments: { path: "after.png" } },
					],
				},
				{ role: "toolResult", toolCallId: "call_one", toolName: "read", content: [{ type: "text", text: "after result" }, afterImage], isError: false, timestamp: 3 },
				{ role: "toolResult", toolCallId: "call:one", toolName: "read", content: [{ type: "text", text: "before result" }, beforeImage], isError: false, timestamp: 4 },
			],
		} as Context;
		const prepared = prepareSendInput(planSend(emptySendState(), context), context, { contextWindow: 200_000, maxTokens: 20_000 });
		expect(prepared.prompt.images).toEqual([
			{ data: afterImage.data, mimeType: afterImage.mimeType },
			{ data: beforeImage.data, mimeType: beforeImage.mimeType },
		]);
		const labels = [...prepared.prompt.text.matchAll(/Attached image (\d+): toolCallId=("[^"]+")/g)];
		expect(labels.map((label) => Number(label[1]))).toEqual([1, 2]);
		const agent = await openAgent({ ...fixture.input, bootstrapHistory: prepared.history });
		try {
			const messages = await Agent.messages.list(agent.agentId, { cwd: fixture.input.cwd, store: fixture.store });
			const turn = messages[0]?.message as {
				turn: { value: { steps: Array<{ message: { value: { toolCallId: string } } }> } };
			};
			const steps = turn.turn.value.steps;
			expect(steps).toHaveLength(2);
			for (const [index, name] of ["after", "before"].entries()) {
				const id = JSON.parse(labels[index]![2]!);
				const matches = steps.filter((step) => step.message.value.toolCallId === id);
				expect(matches).toHaveLength(1);
				expect(matches[0]).toMatchObject({
					message: { case: "toolCall", value: {
						tool: { case: "mcpToolCall", value: {
							args: {
								toolCallId: id,
								args: { path: { kind: { case: "stringValue", value: `${name}.png` } } },
							},
							result: { result: { case: "success", value: {
								content: expect.arrayContaining([expect.objectContaining({
									content: expect.objectContaining({
										case: "text", value: expect.objectContaining({ text: `${name} result` }),
									}),
								})]),
							} } },
						} },
					} },
				});
			}
		} finally {
			await agent[Symbol.asyncDispose]();
		}
	});

	test("rejects saved-agent history before opening or importing", async () => {
		const fixture = setup();
		await expect(openAgent({ ...fixture.input, savedAgentId: "saved-agent" })).rejects.toThrow("only supported for a new agent");
		expect(fixture.create).not.toHaveBeenCalled();
		expect(fixture.resume).not.toHaveBeenCalled();
		expect(fixture.cancel).not.toHaveBeenCalled();
	});

	test("disposes a resumed handle when setup aborts before returning it", async () => {
		const fixture = setup();
		fixture.resume.mockImplementationOnce(async () => {
			fixture.signal.abort(new Error("resume aborted"));
			return { agentId: "owned-agent", async [Symbol.asyncDispose]() {
				fixture.disposed.push("resumed");
			} } as SDKAgent;
		});
		await expect(openAgent(fixture.input)).rejects.toThrow("resume aborted");
		expect(fixture.disposed).toEqual(["seed", "resumed"]);
		expect(fixture.cancel).toHaveBeenCalledTimes(1);
	});

	test("a partial blob write never publishes a checkpoint or resumes", async () => {
		const fixture = setup();
		const createBlob = fixture.store.checkpoints.create.bind(fixture.store.checkpoints);
		const write = spyOn(fixture.store.checkpoints, "create");
		cleanups.push(() => write.mockRestore());
		write.mockImplementationOnce(createBlob).mockRejectedValueOnce(new Error("disk full"));
		await expect(openAgent(fixture.input)).rejects.toThrow("disk full");
		expect((await fixture.store.agents.get({ agentId: "owned-agent" }))?.latestCheckpoint).toBeUndefined();
		expect(fixture.disposed).toEqual(["seed"]);
		expect(fixture.resume).not.toHaveBeenCalled();
	});

	test.each([
		{ agentId: "someone-else" },
		{ status: "running" as const },
		{ startedAt: 10 },
	])("never cancels an initialization it cannot own: %j", async patch => {
		const fixture = setup();
		fixture.setRun(patch);
		await expect(openAgent(fixture.input)).rejects.toThrow();
		expect(fixture.cancel).not.toHaveBeenCalled();
		expect(fixture.disposed).toEqual(["seed"]);
		expect(fixture.resume).not.toHaveBeenCalled();
	});

	test("abort during seed disposal cancels only its queued initialization and publishes nothing", async () => {
		const fixture = setup();
		fixture.create.mockImplementationOnce(async () => {
			await fixture.store.agents.create({ agent: {
				agentId: "owned-agent", cwd: fixture.input.cwd, status: "idle",
				activeRunId: "owned-init", createdAt: 1, updatedAt: 1,
			} });
			await fixture.store.runs.create({ run: {
				agentId: "owned-agent", runId: "owned-init", turnNumber: 1,
				status: "queued", createdAt: 1, updatedAt: 1,
			} });
			return { agentId: "owned-agent", async [Symbol.asyncDispose]() {
				fixture.disposed.push("seed");
				fixture.signal.abort(new Error("setup aborted"));
			} } as SDKAgent;
		});
		await expect(openAgent(fixture.input)).rejects.toThrow("setup aborted");
		expect(fixture.cancel).toHaveBeenCalledWith("owned-init", { cwd: fixture.input.cwd, store: fixture.store });
		expect(fixture.disposed).toEqual(["seed"]);
		expect((await fixture.store.agents.get({ agentId: "owned-agent" }))?.latestCheckpoint).toBeUndefined();
		expect(fixture.resume).not.toHaveBeenCalled();
	});
});
