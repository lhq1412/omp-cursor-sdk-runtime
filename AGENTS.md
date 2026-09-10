# Repository Guidelines

## Project Overview

`omp-cursor-sdk-runtime` is an Oh My Pi (OMP) extension exposing the official `@cursor/sdk` **local** agent runtime as provider `cursor-sdk` (API `cursor-sdk-agent`). It is independent of OMP's built-in `cursor/*` provider. OMP owns sessions, permissions, tools and UI; this adapter translates context, streams SDK output and maintains local-agent bindings. There is no standalone CLI.

## Architecture & Data Flow

- `src/index.ts` registers the provider, dynamic model catalog, session hooks and model commands. `src/provider.ts` builds one SDK selection for agent open/send; `src/catalog.ts` projects canonical IDs, thinking capabilities and context tiers, with credential-scoped raw metadata. `src/model-controls.ts` owns fast flags/session preferences and native refresh, checking the discovery callback because OMP may swallow fetch failures and reuse its cache.
- `src/session-runtime.ts` prepares/reuses agents and commits successful turns. `src/context.ts` selects budgeted native history separately from sanitized system + current-turn send text; divergent context (including raw system text) triggers fresh import. `src/native-history.ts` converts selected history into checkpoint blobs; `src/sdk-session.ts` installs them and creates/resumes official local SDK agents. Empty history uses normal create; committed incremental and live parked-call continuation flows remain intact.
- SDK deltas pass through `src/projector.ts` into OMP assistant events. `src/omp-tools.ts`, `src/tool-catalog.ts` and `src/tools.ts` translate granted OMP tools into SDK custom tools.
- With an explicit `OmpHostBridgeV1` (`src/contracts.ts`, option `ompCursorRuntimeHost`), tools execute through the host. Without it, `src/live-run.ts` parks SDK callbacks, yields `toolUse`, then resolves callbacks from trailing OMP `toolResult` messages on the next invocation. These parked callbacks cannot survive process restart.
- Runtime Maps are keyed by session scope and agent instance. `src/session-resume.ts` folds/persists `cursor-sdk-agent-resume` custom entries in OMP JSONL; `src/store.ts` scopes SDK storage. Only matching committed handles are reusable. Branch navigation, compaction, failed turns and cwd/credential changes invalidate reuse; lifecycle hooks dispose stale runtime state.

Preserve these boundaries:

- Reject cloud `bc-*` agent IDs. Native Cursor executors remain disabled; tools run only through OMP grants. Do not broaden explicit or empty grants.
- Never set SDK `AgentOptions.systemPrompt`. The backend currently rejects `--system-prompt`; that native system-role option stays unused. Keep SDK `settingSources: []` and `mcpServers: {}`.
- On a fresh bootstrap, import selected history natively, not as flattened send text. Prepend sanitized OMP system instructions when nonempty to the current-turn send as `System instructions from OMP:\n${sanitized}` (including the first user turn). Incremental sends omit that prefix; the existing agent retains the bootstrap. Sanitize by joining `string | string[]` with newlines; if the text does not start with `<system-conventions>`, trim it. Otherwise drop from `\n# Internal URLs\n` through the following `\n§ Workflow\n` (both markers required, else trim) and join the prefix (`trimEnd`), the literal `OMP host tool catalog and tool policy omitted: Cursor can call only Cursor SDK tools exposed in this run.`, and the Workflow suffix (`trimStart`) with `\n\n`.
- Native history import bypasses the SDK's initial environment tool-namespace advertisement. Include shared `SDK_TOOL_CONTEXT` plus `\n\n` only when selected bootstrap history remains nonempty after whole-interaction trimming, after the sanitized OMP prefix and before current/recovery text; count its full text in the existing budget. Inclusion depends on retained history, not tool grants: the public `custom-user-tools` guidance says “any tools granted” and never expands grants. Optional history trimmed to empty omits the cue; required recovery fails if its retained interaction and cue cannot fit. First-user/no-history and incremental sends omit it. Keep the default SDK system prompt native and separate from the OMP prefix; never copy SDK environment/user rules or schemas or hardcode model-specific discovery tool names.
- Fresh native import cancels only the queued initialization owned by that create, disposes the seed agent, writes all checkpoint blobs before publishing the root last, then resumes through the official SDK. Never cancel unrelated runs or replay completed tools.
- Reuse requires the `native-checkpoint-v1` fingerprint of original raw joined system text + full messages; old flattened-history bindings rebootstrap. Keep the 20-incremental-turn rebootstrap threshold.
- Current/user/developer history images remain native. Required completed tool-result images are also attached to the continuation send because the root's model projection otherwise exposes only image placeholders. The reused mapper accepts K3 assistant history only with API `cursor-agent`, provider `cursor`, and the exact K3 model; never relabel this adapter's `cursor-sdk` assistant identity to satisfy it, so those imports fail closed. Other models' thinking is omitted.
- Persist credential hashes, never API keys. Mark bindings in-flight before advancing an agent and commit only after success.
- Keep the `sdk-exit-guard.js` side-effect import before SDK initialization; it prevents SDK teardown from terminating the OMP host.

## Key Directories

- `src/`: flat adapter modules; keep provider orchestration, context translation and session persistence separated.
- `test/unit/`: module-focused behavioral tests; `test/helpers/`: shared host doubles.
- `scripts/`: import-boundary check and optional live SDK contract probe.
- `.github/workflows/`: CI verification and manual release automation.

## Development Commands

```bash
npm ci                         # reproducible install from package-lock.json
npm run typecheck              # tsc --noEmit
npm test                       # bun test --isolate test
bun test --isolate test/unit/context.test.ts  # focused test
npm run check:boundaries        # forbidden imports in src/
npm pack --dry-run              # inspect package contents (also checked by CI)
omp plugin link .              # load this checkout into OMP
omp models cursor-sdk          # verify provider discovery
omp --model cursor-sdk/composer-2.5
npm run probe:sdk              # live SDK calls; requires CURSOR_API_KEY
```

There is no build, lint, formatter or start script. OMP loads TypeScript directly; do not introduce a `dist/` workflow. Restart OMP after source changes. If linking leaves the model list empty, follow README's `~/.omp/plugins/package.json` file-dependency setup. Authenticate with `/login cursor-sdk` inside OMP or `CURSOR_API_KEY`; built-in Cursor OAuth/Desktop/CLI credentials are not SDK keys.

## Code Conventions & Common Patterns

- Strict TypeScript, ESM, ES2024/NodeNext. Source imports use explicit `.js` suffixes; tests import source with `.ts`. Match existing tab indentation, double quotes and semicolons.
- Use kebab-case module names, camelCase functions/variables, PascalCase types and uppercase underscore constants. Registration helpers follow `registerCursor…` and accept narrow `Pick<ExtensionAPI, …>` interfaces.
- Reuse plain functions and typed host contracts rather than adding a DI container. Existing tests inject agents through `__testUtils.setOpenAgent`; runtime state lives in module-level Maps/objects with explicit reset/dispose hooks.
- Streaming starts through `queueMicrotask`; live execution races completion, parked tools and cancellation. Route aborts through live-run cancellation so pending callbacks are rejected and the SDK run is cancelled, not merely the output stream closed.
- Use plain `Error` for runtime failures and existing `ToolBridgeError`/`CloudAgentRejectedError` for their domains. Preserve provider error-event and failed-binding cleanup paths. Deduplicate tool execution by `toolCallId`.
- Only `src/native-history.ts` may reuse these user-authorized pure conversion imports: `buildGrpcRequest` from `@oh-my-pi/pi-ai/providers/cursor`, `ConversationStateStructureSchema` from `@oh-my-pi/pi-catalog/discovery/cursor-proto`, and `toBinary` from `@oh-my-pi/pi-catalog/discovery/protobuf`. Discard `requestBytes`; never invoke built-in provider transport, auth or executors. All other built-in Cursor implementation imports and `@cursor/sdk/dist/internal` remain forbidden; `src/constants.ts` defines the boundary-script rules.

## Important Files

- `package.json`: scripts, runtime engines, pinned dependencies and `omp.extensions` entry point; `package-lock.json`: canonical dependency resolution.
- `tsconfig.json`: strict, no-emit checks of `src/` only; tests and scripts are excluded.
- `src/provider.ts`, `src/session-runtime.ts`, `src/live-run.ts`: turn, tool-continuation and cancellation flow.
- `src/session-resume.ts`, `src/context.ts`, `src/native-history.ts`, `src/sdk-session.ts`: persisted binding validity, send planning and native checkpoint import; read these before changing agent reuse.
- `src/model-controls.ts`: `/cursor-fast`, `/cursor-refresh-models`, CLI flags, and session-fold of `cursor-fast-state`.
- `src/contracts.ts`, `src/constants.ts`: host bridge contract and adapter invariants.
- `README.md`: installation, authentication, model controls, capability gaps and live verification instructions.

## Runtime/Tooling Preferences

Use **Bun ≥1.3.14** for OMP/runtime tests; Node alone is not the supported test executor. The manifest also requires **Node ≥22.19.0**. Use **npm** for repository installs and lockfile updates; the npm lockfile is canonical. Current exact runtime pins are `@cursor/sdk` **1.0.31** and `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-coding-agent` **18.1.14**. Treat upgrades as SDK/host contract changes, not routine version bumps.

## Testing & QA

Tests use `bun:test` (`describe`, `test`, `expect`) in `test/unit/<module>.test.ts`. Preserve `--isolate` for file isolation and reset module singletons between cases through existing `__testUtils` hooks. Reuse `test/helpers/fake-host.ts` and injected fake agents; unit tests should not require live credentials.

Prioritize observable contracts: bootstrap versus incremental sends, sanitized system instructions on bootstrap only, committed resume eligibility, branch/cwd/credential invalidation, tool grants and deduplication, parked-call continuation and cancellation, `/cursor-fast` session fold, and honest `/cursor-refresh-models` failures. No coverage threshold is configured.

CI runs install, typecheck, unit tests, boundary checks and package dry-run. For SDK-facing changes, the optional `scripts/sdk-contract-probe.ts` checks that native `AgentOptions.systemPrompt` stays omitted, imports a synthetic history token through the production importer, prefixes only its first imported-history send with the provider's shared `SDK_TOOL_CONTEXT`, verifies a single custom-tool callback with `toolCallId`, and checks token retention after `Agent.resume` without another tool execution. It is not part of CI; run only with an available SDK key and never record that key in files or output.
