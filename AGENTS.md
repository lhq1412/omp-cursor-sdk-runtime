# Repository Guidelines

## Project Overview

`omp-cursor-sdk-runtime` is an Oh My Pi (OMP) extension exposing the official `@cursor/sdk` **local** agent runtime as provider `cursor-sdk` (API `cursor-sdk-agent`). It is independent of OMP's built-in `cursor/*` provider. OMP owns sessions, permissions, tools and UI; this adapter translates context, streams SDK output and maintains local-agent bindings. There is no standalone CLI.

## Architecture & Data Flow

- `src/index.ts` registers the provider, dynamic model catalog, session hooks and model commands. `src/provider.ts` exposes `streamCursorRuntime`; `src/provider-turn-runner.ts` builds one SDK selection and runs agent open/send; `src/catalog.ts` projects canonical IDs, thinking capabilities, context tiers and first-party reference list prices, with credential-scoped raw metadata. `src/model-controls.ts` owns fast flags/session preferences and native refresh, checking the discovery callback because OMP may swallow fetch failures and reuse its cache. `src/usage-command.ts` registers `/cursor-usage`; `src/usage.ts` maps official `agent.getUsage()` snapshots (top-level totals, not summed turn details) without writing message `usage.cost`. `src/usage-provider.ts` feeds the same snapshots into OMP `/usage` for process-known live agents of one API key, not the current session and not Cursor account quota.
- `src/session-runtime.ts` prepares/reuses agents and commits successful turns. `src/context.ts` selects budgeted native history separately from sanitized system + current-turn send text; divergent context (including raw system text) triggers fresh import. `src/native-history.ts` converts selected history into checkpoint blobs and reads settled `tokenDetails` occupancy through the public store; `src/sdk-session.ts` installs them and creates/resumes official local SDK agents. Empty history uses normal create; committed incremental and live parked-call continuation flows remain intact. Successful settles may set `usage.contextTokens` from that occupancy; billing stays in `usage.orchestration`.
- SDK deltas pass through `src/projector.ts` into OMP assistant events; the projector owns SDK → OMP tool-call identity projection. `src/tool-call-id.ts` maps SDK IDs to OMP-portable IDs and OMP IDs to Cursor native checkpoint IDs. `src/omp-tools.ts`, `src/tool-catalog.ts` and `src/tools.ts` translate granted OMP tools into SDK custom tools.
- `src/web-search-tool.ts` shadows OMP `web_search`. Non-`cursor-sdk` models run `src/cursor-web-search.ts`: an ephemeral SDK agent with `tools: ["webSearch"]` only, then `ctx.invokeTool` fallback. `src/omp-tools.ts` never projects `web_search` as a custom tool. When OMP granted `web_search`, `src/sdk-session.ts` may add native `webSearch` to the session agent allowlist. Hooked native `read`/`grep`/`shell`/`edit`/`glob`/`piWrite`/`ls` execute through OMP grants; other native executors stay disabled. Do not reuse session-runtime/live-run/resume for search.
- With an explicit `OmpHostBridgeV1` (`src/contracts.ts`, option `ompCursorRuntimeHost`), tools execute through the host. Without it, `src/live-run.ts` parks SDK callbacks, yields `toolUse`, then resolves callbacks from trailing OMP `toolResult` messages on the next invocation. These parked callbacks cannot survive process restart.
- Runtime Maps are keyed by session scope and agent instance. `src/session-resume.ts` folds/persists `cursor-sdk-agent-resume` custom entries in OMP JSONL; `src/store.ts` scopes SDK storage. Only matching committed handles are reusable. Branch navigation, compaction, failed turns, cwd/credential changes, and hooked native-tool or webSearch grant changes invalidate reuse; parked continuation fails closed on those grant changes. Lifecycle hooks dispose stale runtime state.

Preserve these boundaries:

- Never edit Oh My Pi source (`oh-my-pi`, `oh-my-pi-context-mgmt`, or other OMP package trees) from this adapter. Needed host/catalog/session changes go through an upstream OMP PR and a published `@oh-my-pi/*` bump here. This checkout only owns `omp-cursor-sdk-runtime`.
- Reject cloud `bc-*` agent IDs. Tools run only through OMP grants. Do not broaden explicit or empty grants. Native Cursor executors stay disallowed except hooked `read`/`grep`/`shell`/`edit`/`glob`/`piWrite`/`ls`, and `webSearch` when OMP granted `web_search`.
- Never set SDK `AgentOptions.systemPrompt`. The backend currently rejects `--system-prompt`; that native system-role option stays unused. Keep SDK `settingSources: []` and `mcpServers: {}`.
- On a fresh bootstrap, import selected history natively, not as flattened send text. Prepend sanitized OMP system instructions when nonempty to the current-turn send as `System instructions from OMP:\n${sanitized}` (including the first user turn). Incremental sends omit that prefix; the existing agent retains the bootstrap. Sanitize by joining `string | string[]` with newlines; if the text does not start with `<system-conventions>`, trim it. Otherwise drop from `\n# Internal URLs\n` through the following `\n§ Workflow\n` (both markers required, else trim) and join the prefix (`trimEnd`), the literal `OMP host tool catalog and tool policy omitted: Cursor can call only Cursor SDK tools exposed in this run.`, and the Workflow suffix (`trimStart`) with `\n\n`.
- Native history import bypasses the SDK's initial environment tool-namespace advertisement. Include shared `SDK_TOOL_CONTEXT` plus `\n\n` only when selected bootstrap history remains nonempty after whole-interaction trimming, after the sanitized OMP prefix and before current/recovery text; count its full text in the existing budget. Inclusion depends on retained history, not tool grants: the public `custom-user-tools` guidance says “any tools granted” and never expands grants. Optional history trimmed to empty omits the cue; required recovery fails if its retained interaction and cue cannot fit. First-user/no-history and incremental sends omit it. Keep the default SDK system prompt native and separate from the OMP prefix; never copy SDK environment/user rules or schemas or hardcode model-specific discovery tool names.
- Fresh native import cancels only the queued initialization owned by that create, disposes the seed agent, writes all checkpoint blobs before publishing the root last, then resumes through the official SDK. Never cancel unrelated runs or replay completed tools.
- Reuse requires the `native-checkpoint-v1` fingerprint of original raw joined system text + full messages; old flattened-history bindings rebootstrap. Keep the 20-incremental-turn rebootstrap threshold.
- Current/user/developer history images remain native. Required completed tool-result images are also attached to the continuation send because the root's model projection otherwise exposes only image placeholders. The reused mapper accepts K3 assistant history only with API `cursor-agent`, provider `cursor`, and the exact K3 model; never relabel this adapter's `cursor-sdk` assistant identity to satisfy it, so those imports fail closed. Other models' thinking is omitted.
- Persist credential hashes, never API keys. Mark bindings in-flight before advancing an agent and commit only after success.
- Keep the `sdk-exit-guard.js` side-effect import before SDK initialization; it prevents SDK teardown from terminating the OMP host.
- Cursor SDK-native tool-call IDs are runtime-private. Before any tool call reaches an OMP assistant event, host tool execution, parked-tool result correlation, or persisted session history, project it to an OMP-portable tool-call ID. OMP IDs must satisfy the strict shared provider format (`[A-Za-z0-9_-]+`, ≤64) and must pair assistant calls with tool results. Keep SDK-native IDs only for SDK callback deduplication and live runtime bookkeeping. Native checkpoint import is the opposite direction and continues to derive `nativeToolCallId` from the OMP ID. Legacy read migration only normalizes non-portable SDK IDs on load; it does not repair duplicate toolCall records already persisted by older versions. Those histories continue to fail the native history duplicate guard — start a new session or branch from before the duplicate. Never repair OMP JSONL in place. Do not add Codex-specific ID workarounds.

## Key Directories

- `src/`: flat adapter modules; keep provider orchestration, context translation and session persistence separated.
- `test/unit/`: module-focused behavioral tests; `test/compat/`: real installed OMP host/cache contracts; `test/helpers/`: shared host doubles.
- `scripts/`: deep-import enforcement, offline OMP and live SDK contract probes, and isolated packed-plugin install smoke.
- `.github/workflows/`: shared CI verification; manual release must pass the same verification before publishing.

## Development Commands

```bash
npm ci                         # reproducible install from package-lock.json
npm run typecheck              # tsc --noEmit
npm test                       # bun test --isolate test
bun test --isolate test/unit/context.test.ts  # focused test
npm run check:boundaries        # approved imports in src/ and scripts/
npm pack --dry-run              # inspect package contents (also checked by CI)
omp plugin link .              # load this checkout into OMP
omp models cursor-sdk          # verify provider discovery
omp --model cursor-sdk/composer-2.5
npm run probe:sdk              # live SDK calls; requires CURSOR_API_KEY
npm run probe:omp              # offline OMP codec/model/tool/package contracts
npm run smoke:install          # real packed-plugin install in a temporary home
```

There is no build, lint, formatter or start script. OMP loads TypeScript directly; do not introduce a `dist/` workflow. Restart OMP after source changes. If linking leaves the model list empty, follow README's `~/.omp/plugins/package.json` file-dependency setup. Authenticate with `/login cursor-sdk` inside OMP or `CURSOR_API_KEY`; built-in Cursor OAuth/Desktop/CLI credentials are not SDK keys.

## Code Conventions & Common Patterns

- Strict TypeScript, ESM, ES2024/NodeNext. Source imports use explicit `.js` suffixes; tests import source with `.ts`. Match existing tab indentation, double quotes and semicolons.
- Use kebab-case module names, camelCase functions/variables, PascalCase types and uppercase underscore constants. Registration helpers follow `registerCursor…` and accept narrow `Pick<ExtensionAPI, …>` interfaces.
- Reuse plain functions and typed host contracts rather than adding a DI container. Existing tests inject agents through `__testUtils.setOpenAgent`; runtime state lives in module-level Maps/objects with explicit reset/dispose hooks.
- Streaming starts through `queueMicrotask`; live execution races completion, parked tools and cancellation. Route aborts through live-run cancellation so pending callbacks are rejected and the SDK run is cancelled, not merely the output stream closed.
- Use plain `Error` for runtime failures and existing `ToolBridgeError`/`CloudAgentRejectedError` for their domains. Preserve provider error-event and failed-binding cleanup paths. Deduplicate tool execution by `toolCallId`.
- Within runtime source, only `src/native-history.ts` may reuse these user-authorized pure conversion imports: `buildGrpcRequest` from `@oh-my-pi/pi-ai/providers/cursor`, `ConversationStateStructureSchema` from `@oh-my-pi/pi-catalog/discovery/cursor-proto`, and `pb` / `toBinary` from `@oh-my-pi/pi-catalog/discovery/protobuf`. Discard `requestBytes`; never invoke built-in provider transport, auth or executors. `src/sdk-native-hook.ts` may import pure Cursor→OMP arg translation from `@oh-my-pi/pi-ai/providers/cursor-pi-args` and the exported `buildPiFindResult` / `buildPiLsResult` / `buildPiWriteResult` / `buildPiWriteRejected` codecs from `@oh-my-pi/pi-ai/providers/cursor/exec-modern`. Never import `@oh-my-pi/pi-ai/utils` — that entry is `src/utils.ts`, which imports `@oh-my-pi/pi-utils` and OMP's plugin loader cannot resolve it. Legacy SDK local-resource result envelopes stay adapter-owned; reuse only explicitly allowlisted pure OMP codecs. `scripts/check-boundaries.ts` denies unapproved OMP deep imports by file and symbol, including explicit ownership for taxonomy, model exports, and the offline contract probe's decoding fixtures. `src/constants.ts` retains the forbidden built-in Cursor and SDK-internal import patterns.

## Important Files

- `package.json`: scripts, runtime engines, pinned dependencies and `omp.extensions` entry point; `package-lock.json`: canonical dependency resolution.
- `tsconfig.json`: strict, no-emit checks of `src/` and `scripts/omp-contract-probe.ts`; tests and other scripts are excluded.
- `src/provider.ts`, `src/provider-turn-runner.ts`, `src/session-runtime.ts`, `src/live-run.ts`: turn, tool-continuation and cancellation flow.
- `src/session-resume.ts`, `src/context.ts`, `src/tool-call-id.ts`, `src/native-history.ts`, `src/sdk-session.ts`: persisted binding validity, send planning, SDK↔OMP tool-call IDs, and native checkpoint import; read these before changing agent reuse.
- `src/model-controls.ts`: `/cursor-fast`, `/cursor-refresh-models`, CLI flags, and session-fold of `cursor-fast-state`.
- `src/usage.ts`, `src/usage-command.ts`, `src/usage-provider.ts`: official SDK agent usage snapshots, session `/cursor-usage`, and credential-scoped OMP `/usage`; keep separate from Run token projection, checkpoint occupancy, and catalog reference prices.
- `src/contracts.ts`, `src/constants.ts`: host bridge contract and adapter invariants.
- `src/web-search-tool.ts`, `src/cursor-web-search.ts`: OMP `web_search` shadow and isolated Cursor search sidecar.
- `README.md`: installation, authentication, model controls, capability gaps and live verification instructions.

## Runtime/Tooling Preferences

Use **Bun ≥1.3.14** for OMP/runtime tests; Node alone is not the supported test executor. The manifest also requires **Node ≥22.19.0**. Use **npm** for repository installs and lockfile updates; the npm lockfile is canonical. Current exact runtime pins are `@cursor/sdk` **1.0.31** and `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-utils` **18.2.0**. Treat upgrades as SDK/host contract changes, not routine version bumps.

## Testing & QA

Tests use `bun:test` (`describe`, `test`, `expect`) in `test/unit/<module>.test.ts`. Preserve `--isolate` for file isolation and reset module singletons between cases through existing `__testUtils` hooks. Reuse `test/helpers/fake-host.ts` and injected fake agents; unit tests should not require live credentials.

Prioritize observable contracts: bootstrap versus incremental sends, sanitized system instructions on bootstrap only, committed resume eligibility, branch/cwd/credential invalidation, tool grants and deduplication, parked-call continuation and cancellation, write-time portable tool-call IDs, provider-neutral legacy session ID migration that does not collapse duplicate-corrupted JSONL, parked/host correlation on OMP IDs, SDK callback dedupe remaining on raw SDK IDs, `/cursor-fast` session fold, honest `/cursor-refresh-models` failures, `web_search` sidecar versus native fallback, not bridging `web_search` into Cursor custom tools, `/cursor-usage` using agent totals rather than summing listed turns or pricing `usage.cost`, native `/usage` remaining credential-scoped live agents, and checkpoint occupancy staying out of Run billing. No coverage threshold is configured.

CI runs install, typecheck, unit/host compatibility tests, SDK and offline OMP contract probes, boundary checks, package dry-run, and real packed-plugin installation. `scripts/omp-contract-probe.ts` verifies codec/argument/model/tool contracts and exact OMP package coherence without Cursor network access. `scripts/sdk-contract-probe.ts` checks that native `AgentOptions.systemPrompt` stays omitted, imports a synthetic history token through the production importer, prefixes only its first imported-history send with the provider's shared `SDK_TOOL_CONTEXT`, verifies a single custom-tool callback with `toolCallId`, and checks token retention after `Agent.resume` without another tool execution. After those native checks pass, it spawns isolated `--cancellation-case cancel|dispose` children, records `CAPABILITY` JSON, and treats a child non-zero exit as probe exit 2 without rewriting PASS lines. CI requires a dedicated `CURSOR_API_KEY` Actions secret; missing credentials fail the release gate. Never upload local credentials without authorization or record keys in files/output.
