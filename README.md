# omp-cursor-sdk-runtime

Independent [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) provider adapter for the official `@cursor/sdk` **local** agent runtime.

The extension registers models under **`cursor-sdk/*`**. It does not replace or modify OMP's built-in **`cursor/*`** provider. It reuses only the pure local history mapper and protobuf codec; authentication, transport, agent execution, tools, and resume remain on the official Cursor SDK or this adapter, never the built-in provider's network or executor paths. `check:boundaries` denies unapproved OMP deep imports and restricts approved symbols to their owning adapter modules.

OMP owns sessions, permissions, tools, and UI. This package binds a local Cursor SDK agent onto the current OMP session leaf and executes every granted tool through the OMP host as an SDK custom tool. Cursor-native business tools stay disabled.

This is a separate adapter from [lhq1412/omp-cursor-sdk](https://github.com/lhq1412/omp-cursor-sdk). That package keeps Cursor's native agent loop and optional Cloud; this package uses SDK local in-process runtime with a park-and-yield tool loop so stock brew OMP can approve and run tools.

Pinned baselines:

- Package `0.4.0`
- OMP `18.2.8` (all four direct OMP packages exact-pinned)
- `@cursor/sdk` `1.0.31`
- Direct history-codec dependency: `@oh-my-pi/pi-catalog` `18.2.8`

Native checkpoint conversion is coupled to these fixed versions, not a promise of compatibility with arbitrary OMP or SDK releases.

## Requirements

- OMP 18.2.8
- Bun 1.3.14 or newer (OMP and the extension runtime)
- Node.js 22.19 or newer (maintenance scripts)
- a Cursor SDK API key from Cursor Dashboard → API Keys

The extension does not reuse Cursor Desktop, Cursor Agent CLI, or OMP built-in Cursor OAuth credentials.

## Install

From GitHub:

```bash
omp plugin install github:lhq1412/omp-cursor-sdk-runtime
```

From a local checkout:

```bash
npm install
omp plugin link .
```

OMP loads plugins declared in `~/.omp/plugins/package.json`. After linking, add a `file:` dependency if `omp models cursor-sdk` is empty:

```bash
cd ~/.omp/plugins
bun add /absolute/path/to/omp-cursor-sdk-runtime
```

The package manifest uses OMP's native `omp.extensions` entry and loads `src/index.ts` directly under Bun. There is no generated `dist/` build step.

Restart `omp` after pulling adapter changes (the plugin is a symlink into this repo).

## Authenticate

Preferred interactive flow:

1. Start OMP.
2. Run `/login cursor-sdk`.
3. Paste a Cursor SDK API key into the hidden-input prompt.

Environment flow:

```bash
export CURSOR_API_KEY="your-key"
omp --model cursor-sdk/composer-2.5
```

One-shot flow:

```bash
omp --api-key "your-key" --model cursor-sdk/composer-2.5 -p "Reply with OK."
```

Credential boundary:

- OMP resolves `cursor-sdk` login, provider configuration, and `--api-key` credentials.
- `CURSOR_API_KEY` is the explicit environment fallback.
- OMP's built-in `cursor` OAuth and Cursor Desktop/CLI login are never treated as Cursor SDK API keys.
- Keys are not written to debug output or repository files. Resume identity stores a hash of the key, never the raw key.

## Models

List or refresh the independent provider catalog:

```bash
omp models cursor-sdk
omp models refresh
```

Models are **canonical IDs only** (`cursor-sdk/composer-2.5`). Fast is a per-send flag, not a catalog alias: there are no `@fast` / slow suffix rows.

OMP's materialized selector cache and the adapter's credential-scoped SDK metadata cache remain separate. The first turn restores SDK selection metadata from the private cache when one exists and refreshes it from live discovery in the background; without a cache it waits for live discovery. If a successful live catalog no longer contains the selected model, the next turn fails with a refresh/reselection error instead of sending an unverified raw ID. A live discovery failure still permits a model with verified private-cache configuration.

The native model browser's input/output prices are **base-mode reference USD per million tokens, not Cursor SDK charges**. The adapter first checks an exact, nonzero OMP bundled Cursor price, then exact IDs in the bundled OpenAI, Anthropic, Google and xAI catalogs. A small explicit map covers Cursor's alternate Claude names; display names, SDK aliases, arbitrary suffixes and Gemini preview variants are not guessed. Prices follow the pinned OMP catalog, not a live price feed; SDK model IDs, capabilities and selection parameters remain authoritative.

When a bundled Cursor price is zero, matched first-party models supply reference comparisons. Models without a reliable price, including Composer, retain structural zero prices because the provider config requires numeric rates. A native model browser displaying those placeholders as `free` does not mean these models are free. The plain `omp models` table has no price columns; use the interactive model browser for comparisons.

Reference rates do not account for Cursor fast mode, long-context premiums, discounts or plan coverage. Extended-context rows retain the SDK threshold but repeat the base reference rates; they do not import the vendor's pricing tiers. These catalog rates are not used to calculate assistant-message costs: message `usage.cost` remains unavailable, and token/context accounting is unchanged. Restart OMP after updating the extension, then run `/cursor-refresh-models` to refresh the model list.

```bash
omp --model cursor-sdk/composer-2.5
omp --model cursor-sdk/gpt-5.5:xhigh  # when this model/effort is in your live catalog
```

Thinking uses native OMP `:level` suffixes and the thinking selector (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), limited to each model's advertised capabilities. Composer's fallback has fast but no thinking selector. Extended context uses native `/extended-context [on|off|status]` or Settings → Extended Context. Exactly two numeric context tiers share one model row; three or more tiers retain explicit non-default `@context` rows. Runtime maps the host-clamped `model.contextWindow` to the SDK context parameter. Missing or unparseable SDK context uses `max(200k fallback, Cursor family floor)` matching OMP 18.2.1: Grok 4.5/4.6 and Auto/`default` 256k, Kimi K2.7 Code 262k, GPT-5.6 272k, Claude Opus 5 / Fable 300k, K3 1M. Parseable SDK tiers stay as listed; two-tier `longContext` thresholds stay the SDK standard value.

When switching from `cursor-sdk` to OMP's built-in Codex provider, the extension maps its historical tool-call IDs longer than 64 characters and their paired results to matching 64-character IDs in the outgoing context only. Persisted history and live SDK callback IDs remain unchanged. This also covers existing sessions while the extension is loaded; restart OMP after updating the extension.

In-session:

- `/cursor-fast [on|off|status]` — empty/`toggle` flips the selected canonical model (default off); `--cursor-no-fast` wins `--cursor-fast`; otherwise session custom entries. Status is reported by the command output, not a live slash-menu description. Takes effect on the next new send, not an in-flight parked run. Captures the selected model and actual session identity when invoked; pending commands are discarded without saving or notifying if navigation starts or the identity changes while capabilities load, including before navigation-completed events. If navigation is cancelled, rerun the command.
- `/cursor-refresh-models` — requires a Cursor SDK key and calls native `modelRegistry.refreshProvider("cursor-sdk", "online")`. Success requires a successful live discovery callback, not a silently reused cache; failures retain the previous catalog. `omp models refresh` also goes through `fetchDynamicModels`.
- `/cursor-usage` — queries official Cursor SDK billed usage for **current SDK agents in this session** (`agent.getUsage()`). Shows agent token totals, raw model cost, charged amount, query time, and listed-turn count. This is not a Cursor invoice, not a full session total across discarded agents, and not message `usage.cost`. Missing `cost` is pending settlement; `$0.0000` charged is reported zero, not unknown. If no live agent remains, the command may query the committed resume agent id. Query failures do not fail model turns. OMP `/usage` also loads `cursor-sdk` through `registerProvider({ usage })`: that path is **credential-scoped process-known live agents**, including other sessions sharing the key, and never resume-only or account quota.

Validated SDK parameter/variant metadata is persisted per credential hash under the SDK workspace state root at `omp-cursor-runtime/model-cache/<credential-hash>.json`. Files are private, bounded, validated on read, and atomically replaced; no API key is stored. `ensureCursorModels()` is cache-first: a validated cache for that credential serves the turn immediately and live discovery refreshes behind it; without a cache, live discovery failure is the turn's failure. Known model ids are also published through the SDK's `CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON` bypass so `Agent.create`/`Agent.resume` skip their own `/v1/models` round trip. Metadata `source` distinguishes `sdk`, `cache`, and the existing `fallback`; cached configuration never grants account access. Explicit refresh still reports live discovery failures. `/cursor-fast` also works offline for the known `composer-2.5` fallback. Empty live catalogs are errors, not successful refreshes. Cloud `bc-*` agent IDs remain rejected.

SDK preset variants are valid selections independently of advertised parameter definitions. Live discovery and disk validation preserve their opaque string values, including empty values, without requiring preset IDs/values to appear in `parameters`; malformed structures and duplicate parameter IDs are still rejected.

## Tools

On stock brew OMP, every authorized JSON-schema function tool from `context.tools`, plus enabled xd://-mounted `mcp__*` tools, is mapped one-to-one to a Cursor SDK custom tool. Valid SDK names are preserved; other names receive a deterministic portable name while callbacks and OMP history retain the original name. Schemas, descriptions, examples, and arguments remain OMP-native—there is no Cursor-native argument or result translation.

The SDK allowlist is exactly `["mcp"]` when custom tools exist and `[]` otherwise. The native business-tool deny-list remains explicit, `settingSources` is always `[]`, and `mcpServers` is always `{}`. OMP `web_search`, filesystem, shell, edit, MCP, and other granted tools therefore share the same approval, execution, parking, deduplication, and journal path.

When the model calls a tool, the adapter emits OMP `toolUse`, parks the SDK callbacks, and yields back to OMP. OMP runs the tool with its own permissions and approval (MCP included via the xd:// fallback). The next `streamSimple` resumes the parked callbacks with the trailing `toolResult`s.

Tool calls include the complete JSON argument stream as well as the final arguments, so OMP's streaming tools (including hashline `edit`) receive the same input as ordinary tools.

If those callbacks are gone (for example after a restart or a completed Run), complete recorded text/image tool results can continue on a **fresh agent** instead. Recovery validates the latest assistant batch's call/result IDs, keeps the initiating request and completed interaction within the history budget, imports them as a native checkpoint, and sends an explicit continuation rather than resending the old request as new input. Historical user/developer images remain in native history; current-input images use the SDK send attachments. Required completed **tool-result images** are attached to the recovery continuation in recorded order, with numbered call/result references: the codec's root model projection otherwise contains only image placeholders for tool results. A previously saved agent handle is not reused for this path. Missing, duplicate or unmatched results, missing initiating requests, unsupported or malformed text/image content, and recovery evidence that cannot fit the budget fail explicitly. Existing live callbacks still resume normally without model rediscovery.

Recovery does not execute or re-emit historical tool calls. It tells the model to use the recorded results and not repeat completed actions; this is **not an exactly-once guarantee** for new tool calls the model may subsequently request. OMP still owns tool permissions and approval.

An explicit host grant is used as-is. Stock extras only add currently enabled `mcp__*` names; an empty or read-only grant stays empty.

## System instructions: native `systemPrompt` omitted

Official SDK `1.0.31` supports an account-gated `AgentOptions.systemPrompt` option, but this adapter **does not set it**. The live probe against this account (2026-09-08) rejected it with:

```text
[invalid_argument] unknown option '--system-prompt'
```

Cursor's built-in harness prompt remains in effect. The adapter does not guarantee native system-role delivery or replacement; importing native history does not change that boundary.

A **fresh bootstrap** imports prior history separately and prepends complete OMP system instructions when nonempty to the current/continuation send text as:

```text
System instructions from OMP:
${systemPrompt}
```

Every fresh bootstrap includes the canonical current tool contract—policy, exact custom-tool names, descriptions, and sanitized input schemas—before the current user/developer input or explicit continuation. For bootstrap with nonempty history, `SDK_TOOL_CONTEXT` plus a blank line is also included because native history import bypasses the SDK's initial custom-tool namespace advertisement. Prior history is not flattened into this send. Incremental rounds omit the bootstrap prefixes because the existing agent retains them. Empty or missing system text omits only the OMP system prefix. `activeUserInput` selects only the final user/developer message, never an older user request. The bounded context reuse fingerprint hashes the original raw joined system text and the complete message prefix and requires `native-checkpoint-v1` with `formatVersion: 3`. Older v2 and unversioned `messageHashes[]` fingerprints force a fresh import so an agent cannot retain the former cropped prompt. No session journal or SDK store migration is required. The separate tool-contract fingerprint hashes the canonical granted definitions. A system, history, or tool-contract change forces a fresh import.

All bootstrap guidance counts toward the input budget. Nonempty history must fit in full together with both tool cues; neither history nor policy is silently trimmed. The default SDK system prompt remains native and separate from the OMP prefix.

`serializeSystemPrompt` joins `string | string[]` with newlines; the send prefix trims only outer whitespace. Internal URLs, tool policies, LSP/find guidance, delegation rules, and custom template content are preserved rather than removed by heading markers.

## Session behavior

OMP owns both automatic and manual compaction for `cursor-sdk`. The adapter does not register compaction-cancel hooks and does not convert Cursor-native summary archives into OMP `CompactionEntry` records. `session_compact` still invalidates the current SDK binding, so the next Cursor request imports OMP's compacted history into a fresh SDK agent.

Summary status, text, and count belong to the SDK run and are exposed only as `cursorSdk.summary` snapshots on Cursor SDK assistant messages. Checkpoint `tokenDetails` occupancy remains separate from OMP compaction and billing; it is reported as `cursorSdk.contextOccupancy` when the settled checkpoint is readable.

The SDK may maintain its own native summary state inside its local agent store, but the adapter does not decode, archive, or project that state into the OMP session journal. OMP `/context` therefore follows OMP's own compaction accounting.

Local agents are bound to the current OMP JSONL session leaf, cwd, credential identity, and canonical tool-contract fingerprint. Same-session incremental turns reuse the agent and send only the current user/developer input, or an explicit continuation when no new input exists. Reuse has no incremental-send count limit. Parked tool callbacks retain precedence and fail closed if cwd, credentials, or any granted tool name, description, or schema changes. Fresh agents import the complete current effective history as native checkpoint blobs, translate historical tool names through the same deterministic mapping, then send the separate complete system prefix, tool contract, the history cue when needed, and current input/continuation. Empty history uses normal `Agent.create`. Version-5 resume records retain version-4's bounded persistence identity and add the tool-contract fingerprint; a matching committed handle with the current context fingerprint can be resumed after process restart. Branch navigation, ordinary OMP compaction, failed turns, and cwd/key changes still force fresh bootstrap. Cursor-native summary state does not preserve or rebase the OMP session journal.

Session ownership comes from OMP's `onPayload` → `before_provider_request` hook and its actual session manager, not the most recently registered provider or a routing `sessionId` alone. The hook receives the provider's `Context`; a returned replacement `Context` is used for the request. Parent and child sessions retain separate runtime, resume writers, fast preferences, and tool catalogs. Navigation and shutdown invalidate only the owning session, including requests still awaiting a payload hook or model discovery.

Unbound requests, such as background title generation, use disposable agents and never write another session's resume records—even when their routing ID matches the foreground request. Programmatic callers using tools must retain OMP's payload hook or supply the explicit host bridge; unbound tool-bearing requests fail before execution rather than create unrouteable parked callbacks.

For a nonempty import, the adapter creates and disposes a fresh SDK seed, cancels only that seed's owned, unstarted queued initialization Run, writes all checkpoint blobs, and publishes the agent's root checkpoint reference last before official `Agent.resume`. It refuses to cancel active or unowned initialization work or overwrite a changed agent. No built-in Cursor transport, authentication, or executors run: `src/native-history.ts` uses only `buildGrpcRequest`, `ConversationStateStructureSchema`, `pb`, and `toBinary` for local conversion and discards the generated request bytes.

The imported format follows the pinned codec's model-family limits, not lossless arbitrary-history semantics. Thinking is omitted for non-K3 models. For K3, assistant history is accepted only with `api=cursor-agent`, `provider=cursor`, and the exact target K3 model; even accepted same-model turns may lack thinking. This adapter's `cursor-sdk` assistant identity is **not relabeled** to bypass that check, so K3 imports containing its own assistant turns fail closed. Catalog availability does not guarantee that every model can import every session.

The SDK caches its local workspace executor by cwd, credential, and executor-shaping options. Each session scope holds one executor lease (`prewarmLocalWorkspace`), started at `session_start` for a `cursor-sdk` model with a resolvable key and again at turn preparation, so the first `send()` does not build rules/ignore/tree-sitter state inline and agent disposal (fresh bootstrap, unsafe binding, compaction) no longer tears the executor down. Old-agent disposal runs concurrently with the next agent open. The lease is released when the scope is disposed (session switch/branch/tree/shutdown); a failed prewarm is ignored and `send()` rebuilds.

Cancellation while model discovery is pending ends that request before any runtime binding is prepared; shared discovery may finish for other requests, but its late result cannot resume the cancelled request or touch a newly selected session. Once prepared, cancellation belongs to the in-flight live run (including park-and-yield). SDK `process.reallyExit(0|1)` during teardown is swallowed so `/quit` does not throw `ExtensionExitError`.

Bootstrap budgeting reserves `min(advertised maxTokens, 16,384)`, framing overhead, and 4096 tokens per image in native user/developer history or send attachments (including required recovery tool-result images). It imports all current effective OMP history or refuses with a `/compact` instruction before sending, replacing a binding, or disposing the previous agent. After formal OMP compaction, that history is the existing summary plus retained tail, not every old JSONL message. Tool-result recovery also requires the entire effective prefix, not only the initiating request and completed interaction. Necessary system instructions and the current input are never silently truncated: oversized **text** fails before opening/resuming an agent. Image payload size is not treated as model tokens. The text estimator sizes native-history JSON the codec would emit: user/assistant/tool framing, SHA-256 `toolCallId`s, result ids, and K3 thinking only when `api=cursor-agent`, `provider=cursor`, and the exact target K3 model match. It uses OMP's approximate `(UTF-8 bytes + 3) >> 2` heuristic and ignores serialized OMP host metadata; a local refusal is an estimate, not proof of backend overflow. History-budget refusals use dedicated bootstrap/recovery errors so OMP does not start ContextOverflow compaction. Run normal `/compact`, then retry; summarization and the resulting summary-plus-tail must still fit their own budgets. Unknown model limits fail explicitly. Backend overflow is reported separately from quota/rate limits and local history-budget failures; no automatic retries or tool reexecution are added.

## Results, usage, and diagnostics

Final SDK results fill missing answer text against the current answer step. A matching prefix appends only the suffix; other mismatches replace that step's text instead of concatenating a second copy. Tools are not replayed. Public `run.usage` / `RunResult.usage` counters map into `usage.orchestration` (Run-deduplicated); prompt buckets stay zero. A high-water mark belongs to the SDK Run, so parked and cancelled returns report only newly observed usage, not the same cumulative counts again.

Assistant messages carry `cursorSdk` availability metadata: `tokenUsage` is `actual` or `unavailable`; `contextOccupancy` is `actual` with `source: "checkpoint"` after a successful settled turn whose public store root is new, idle, and stable, otherwise `unavailable`. Run billing and `turn-ended` totals are not occupancy. Occupancy is never copied into `usage.contextTokens`. Parked, cancelled, and unreadable checkpoints leave occupancy `unavailable`. Message `cost` stays `unavailable`: OMP requires numeric cost fields, so their zero placeholders **do not mean free usage**. Official billed totals and dollar amounts come from `/cursor-usage` or OMP `/usage` (`agent.getUsage()`): top-level agent snapshots, not summed listed turns, and not written into `usage.cost`. Local billed IDs are per-turn identities, not SDK Run IDs, and costs can settle later. Some accounts return `feature_unavailable` for `getUsage()`. See the [public SDK usage contracts](https://cursor.com/docs/sdk/typescript#token-usage).

SDK Run billing maps to `usage.orchestration`: input includes cache writes, with output and cache reads in their own orchestration fields. The prompt buckets (`usage.input`, `output`, `cacheRead`, and `cacheWrite`) stay zero, and `usage.totalTokens` is the orchestration sum. OMP subtracts orchestration from `calculateContextTokens` and checks only prompt input/cache buckets for usage-backed overflow, so cumulative Run totals do not masquerade as conversation context.

Provider errors and diagnostic notifications redact credentials, authorization/cookie headers and sensitive query values before display/persistence, while retaining useful error categories and request IDs. Normal assistant/tool content is not globally rewritten.

## Development and verification

```bash
npm install
npm test
npm run typecheck
npm run probe:omp
npm run check:boundaries
npm run smoke:install
```

OMP packages are Bun-targeted, so runtime tests use Bun. GitHub Actions runs `npm ci`, typecheck, tests, `probe:sdk`, `probe:omp`, `check:boundaries`, `npm pack --dry-run`, and the real plugin-install smoke. The SDK step requires a dedicated repository `CURSOR_API_KEY` secret; do not upload a developer's local key without authorization. Missing credentials fail the gate, including on fork pull requests where GitHub does not expose secrets. Never use `pull_request_target` to run untrusted code with that secret.

`probe:omp` is offline: it checks the native-history checkpoint codec, model/tool exports, and agreement of all four exact OMP pins. `smoke:install` packs this checkout, installs its dependencies outside the checkout, and exercises the installed OMP plugin manager and extension loader in a temporary home. It requires package-registry access, but no Cursor credentials.

Real-host tests cover concurrent request owners, abort/retry, same-directory subagents, unscoped auxiliary completions, custom-tool execution counts, and park/resume correlation. Every tool must execute once through OMP; the adapter does not use Cursor-native speculation or executors.

Current package is `0.4.0` on OMP 18.2.8 and SDK 1.0.31. Keep the private credential-scoped model cache separate from OMP's selector cache. Freeze contracts before changing the baseline; do not bundle session-binding or compaction redesigns into a pin bump. Real host cache, request-owner, grant, tool, and lifecycle tests remain the 18.2 gate. Pin-only compatibility stays patch; further session/tool/compaction semantic changes still need a minor bump. A missing or failed live SDK probe is not validated support and blocks release.

The manual release workflow reuses the complete CI workflow before changing the version, pushing a tag, or creating a release. An absent dedicated SDK secret or a failed probe therefore blocks publication; local verification alone does not bypass that gate.

Live SDK probes (requires `CURSOR_API_KEY`):

```bash
export CURSOR_API_KEY=...
npm run probe:sdk
```

The probe records that native `AgentOptions.systemPrompt` is omitted and imports completed tool history plus trailing user/developer messages through the production importer. It prefixes only its first imported-history send with the provider's shared `SDK_TOOL_CONTEXT`, checks one new custom-tool callback and its `toolCallId`, verifies positive settled occupancy on a new checkpoint root, then checks history retention after `Agent.resume` without replaying completed tools. If those PASS, it spawns isolated `--cancellation-case cancel|dispose` children that emit `CAPABILITY` JSON; a child non-zero exit becomes probe exit 2 and does not rewrite PASS lines.

Each cancellation child has one shared 60-second preparation budget for opening the agent, obtaining its run, and entering the blocked tool callback. Remote model/tool-discovery latency does not consume the separate 10-second capability observation windows. The whole-child watchdog remains 180 seconds; preparation failures and child failures still fail CI without automatic retries.

Native-history smoke verification exercised the real provider and official SDK with synthetic OMP lifecycle hooks and session JSONL in isolated scratch, not the full OMP TUI or every model. Eight scenarios passed, covering native history continuation, one actual new-tool side effect, parked-result continuation on the same Agent, persisted resume retaining system/history, raw system-change reimport, cancelled parked Run followed by an isolated branch, OMP compaction invalidation/reimport, and completed screenshot-result recovery identifying blue/magenta/orange. This separate smoke is not part of the probe command above.

The OMP 18.2.8 upgrade smoke exercised the actual OMP CLI over RPC with SDK 1.0.31 in an isolated temporary home: one granted `read`, manual OMP compaction, then a fresh SDK agent recalling the token without another tool call and reporting new settled checkpoint occupancy. A small `keepRecentTokens` override made the short smoke session eligible for compaction. The actual TUI login prompt also masked dummy input; no credential was submitted in that check. These are local smoke results, not substitutes for the release gates.

## Provenance and license

- Related independent-provider work: [lhq1412/omp-cursor-sdk](https://github.com/lhq1412/omp-cursor-sdk). This repository is a new local-runtime adapter, not a copy of that package's native+MCP loop.
- Repository code is MIT licensed; see [LICENSE](LICENSE). Copyright © 2026 lhq1412.
- OMP and `@cursor/sdk` are separate dependencies distributed under their own licenses and are not relicensed by this repository.
- Cursor is a trademark of Anysphere, Inc. This project is not affiliated with or endorsed by Anysphere.
