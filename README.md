# omp-cursor-sdk-runtime

Independent [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) provider adapter for the official `@cursor/sdk` **local** agent runtime.

The extension registers models under **`cursor-sdk/*`**. It does not replace or modify OMP's built-in **`cursor/*`** provider. The sole reuse is its pure local history mapper and protobuf codec; authentication, transport, agent execution, and resume remain on the official Cursor SDK, never the built-in provider's network or executor paths.

OMP owns sessions, permissions, tools, and UI. This package binds a local Cursor SDK agent onto the current OMP session leaf and executes tools only through the OMP host. Native Cursor executors stay disallowed.

This is a separate adapter from [lhq1412/omp-cursor-sdk](https://github.com/lhq1412/omp-cursor-sdk). That package keeps Cursor's native agent loop and optional Cloud; this package uses SDK local in-process runtime with a park-and-yield tool loop so stock brew OMP can approve and run tools.

Pinned baselines:

- OMP `18.1.14` (`daf07999`)
- `@cursor/sdk` `1.0.31`
- Direct history-codec dependency: `@oh-my-pi/pi-catalog` `18.1.14`

Native checkpoint conversion is coupled to these fixed versions, not a promise of compatibility with arbitrary OMP or SDK releases.

## Requirements

- OMP 18.1.14
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

OMP 18.1.14 only loads plugins declared in `~/.omp/plugins/package.json`. After linking, add a `file:` dependency if `omp models cursor-sdk` is empty:

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
3. Paste a Cursor SDK API key.

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

The native model browser's input/output prices are **base-mode reference USD per million tokens, not Cursor SDK charges**. The adapter first checks an exact, nonzero OMP bundled Cursor price, then exact IDs in the bundled OpenAI, Anthropic, Google and xAI catalogs. A small explicit map covers Cursor's alternate Claude names; display names, SDK aliases, arbitrary suffixes and Gemini preview variants are not guessed. The selected model's detail name identifies the source, for example `[base ref: openai/gpt-5.5]`. Prices follow the pinned OMP catalog, not a live price feed; SDK model IDs, capabilities and selection parameters remain authoritative.

All bundled Cursor prices in OMP 18.1.14 are zero, so matched first-party models supply the current comparisons. Models without a reliable price, including Composer, show `[price unknown; not free]` in their detail name. **OMP 18.1.14 still renders structural zero prices as `free` in its native price column; this host label does not mean these models are free.** The plain `omp models` table has no price columns; use the interactive model browser for comparisons.

Reference rates do not account for Cursor fast mode, long-context premiums, discounts or plan coverage. Extended-context rows retain the SDK threshold but repeat the base reference rates; they do not import the vendor's pricing tiers. These catalog rates are not used to calculate assistant-message costs: message `usage.cost` remains unavailable, and token/context accounting is unchanged. Restart OMP after updating the extension, then run `/cursor-refresh-models` to refresh the model list.

```bash
omp --model cursor-sdk/composer-2.5
omp --model cursor-sdk/gpt-5.5:xhigh  # when this model/effort is in your live catalog
```

Thinking uses native OMP `:level` suffixes and the thinking selector (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), limited to each model's advertised capabilities. Composer's fallback has fast but no thinking selector. Extended context uses native `/extended-context [on|off|status]` or Settings → Extended Context. Exactly two numeric context tiers share one model row; three or more tiers retain explicit non-default `@context` rows. Runtime maps the host-clamped `model.contextWindow` to the SDK context parameter.

When switching from `cursor-sdk` to OMP's built-in Codex provider, the extension maps its historical tool-call IDs longer than 64 characters and their paired results to matching 64-character IDs in the outgoing context only. Persisted history and live SDK callback IDs remain unchanged. This also covers existing sessions while the extension is loaded; restart OMP after updating the extension.

In-session:

- `/cursor-fast [on|off|status]` — empty/`toggle` flips the selected canonical model (default off); `--cursor-no-fast` wins `--cursor-fast`; otherwise session custom entries. Status is reported by the command output, not a live slash-menu description. Takes effect on the next new send, not an in-flight parked run. Captures the selected model and actual session identity when invoked; pending commands are discarded without saving or notifying if navigation starts or the identity changes while capabilities load, including before navigation-completed events. If navigation is cancelled, rerun the command.
- `/cursor-refresh-models` — requires a Cursor SDK key and calls native `modelRegistry.refreshProvider("cursor-sdk", "online")`. Success requires a successful live discovery callback, not a silently reused cache; failures retain the previous catalog. `omp models refresh` also goes through `fetchDynamicModels`.
- `/cursor-usage` — queries official Cursor SDK billed usage for **current SDK agents in this session** (`agent.getUsage()`). Shows agent token totals, raw model cost, charged amount, query time, and listed-turn count. This is not a Cursor invoice, not a full session total across discarded agents, and not message `usage.cost`. Missing `cost` is pending settlement; `$0.0000` charged is reported zero, not unknown. If no live agent remains, the command may query the committed resume agent id. Query failures do not fail model turns. OMP `/usage` also loads `cursor-sdk` through `registerProvider({ usage })`: that path is **credential-scoped process-known live agents**, including other sessions sharing the key, and never resume-only or account quota.

Validated SDK parameter/variant metadata is persisted per credential hash under the SDK workspace state root at `omp-cursor-runtime/model-cache/<credential-hash>.json`. Files are private, bounded, validated on read, and atomically replaced; no API key is stored. When live discovery fails, `ensureCursorModels()` may use that credential's cached configuration for known models only. Metadata `source` distinguishes `sdk`, `cache`, and the existing `fallback`; cached configuration never grants account access. Explicit refresh still reports live discovery failures. `/cursor-fast` also works offline for the known `composer-2.5` fallback. Empty live catalogs are errors, not successful refreshes. Cloud `bc-*` agent IDs remain rejected.

SDK preset variants are valid selections independently of advertised parameter definitions. Live discovery and disk validation preserve their opaque string values, including empty values, without requiring preset IDs/values to appear in `parameters`; malformed structures and duplicate parameter IDs are still rejected.

## Tools

On stock brew OMP, `context.tools` plus xd://-mounted tools (including enabled `mcp__*` MCP tools) are mapped to Cursor SDK custom tools. Native Cursor executors (`shell`, `edit`, `read`, `grep`, `glob`, `ls`, `delete`, `task`) stay disallowed. SDK `settingSources` is always `[]`; `mcpServers` is always `{}`.

The extension shadows OMP `web_search`. Non-`cursor-sdk` models try an isolated Cursor SDK agent with only `webSearch` (no shell/edit/MCP/session resume), using `/login cursor-sdk` or `CURSOR_API_KEY`. If Cursor is missing, fails, or finishes without calling `webSearch`, it falls back to OMP's native search chain via `ctx.invokeTool`. `cursor-sdk/*` does not bridge that wrapper as a custom tool; when OMP granted `web_search`, the session agent may use native `webSearch` only.

Native `readMcpResource` and `listMcpResources` are disallowed because `mcpServers` is always `{}`; memoria and `memory://` use granted `mcp__memoria_*` custom tools or the OMP `read` tool, not the SDK MCP resource API.

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

A **fresh bootstrap** imports prior history separately and prepends sanitized OMP system instructions when nonempty to the current/continuation send text as:

```text
System instructions from OMP:
${sanitized}
```

followed by the current user/developer input (including a first turn), or an explicit continuation. For bootstrap with nonempty selected history after whole-interaction trimming, `SDK_TOOL_CONTEXT` plus a blank line sits after the sanitized system prefix and before the current input/continuation. Prior history is not flattened into this send. Incremental rounds omit both prefixes; first-user/no-history sends omit only the tool-context cue. Empty or missing system text omits the OMP system prefix. `activeUserInput` selects only the final user/developer message, never an older user request. The reuse fingerprint hashes the original raw joined system text and full messages and requires `native-checkpoint-v1`: raw system changes and old flattened-history bindings force fresh import.

Imported history bypasses the SDK's initial environment block advertising its public `custom-user-tools` namespace. The minimal cue tells the model to discover schemas there for any tools granted in this run and that native Cursor tools are unavailable; it does not grant tools or copy SDK environment/user rules or schemas. Its full text counts toward the existing bootstrap budget. If optional history trims to empty, the cue is omitted; required recovery still fails if its retained interaction and cue cannot fit. The default SDK system prompt remains native and separate from the sanitized OMP prefix.

Sanitizer (`serializeSystemPrompt` joins `string | string[]` with newlines):

- If the prompt does not start with `<system-conventions>`, use it trimmed.
- Else find `\n# Internal URLs\n`, then `\n§ Workflow\n` after it. If either marker is missing, use the trimmed prompt.
- Else join with `\n\n`: the prefix before Internal URLs (`trimEnd`), the literal `OMP host tool catalog and tool policy omitted: Cursor can call only Cursor SDK tools exposed in this run.`, and the Workflow suffix (`trimStart`).

## Session behavior

Local agents are bound to the current OMP JSONL session leaf, cwd, and credential identity. Same-session incremental turns reuse the agent and send only the current user/developer input, or an explicit continuation when no new input exists. Parked tool callbacks retain precedence. Fresh agents import budgeted prior history as native checkpoint blobs, then send the separate sanitized system prefix, the tool-context cue for nonempty history, and current input/continuation. Empty history uses normal `Agent.create`. Resume records persist the agent's execution cwd; a matching committed handle can be resumed after process restart. Branch navigation, compaction, failed turns, cwd/key changes, and the existing 20-completed-incremental-send threshold start a fresh bootstrap.

Session ownership comes from OMP's `onPayload` → `before_provider_request` hook and its actual session manager, not the most recently registered provider or a routing `sessionId` alone. The hook receives the provider's `Context`; a returned replacement `Context` is used for the request. Parent and child sessions retain separate runtime, resume writers, fast preferences, and tool catalogs. Navigation and shutdown invalidate only the owning session, including requests still awaiting a payload hook or model discovery.

Unbound requests, such as background title generation, use disposable agents and never write another session's resume records—even when their routing ID matches the foreground request. Programmatic callers using tools must retain OMP's payload hook or supply the explicit host bridge; unbound tool-bearing requests fail before execution rather than create unrouteable parked callbacks.

For a nonempty import, the adapter creates and disposes a fresh SDK seed, cancels only that seed's owned, unstarted queued initialization Run, writes all checkpoint blobs, and publishes the agent's root checkpoint reference last before official `Agent.resume`. It refuses to cancel active or unowned initialization work or overwrite a changed agent. No built-in Cursor transport, authentication, or executors run: `src/native-history.ts` uses only `buildGrpcRequest`, `ConversationStateStructureSchema`, and `toBinary` for local conversion and discards the generated request bytes.

The imported format follows the pinned codec's model-family limits, not lossless arbitrary-history semantics. Thinking is omitted for non-K3 models. For K3, assistant history is accepted only with `api=cursor-agent`, `provider=cursor`, and the exact target K3 model; even accepted same-model turns may lack thinking. This adapter's `cursor-sdk` assistant identity is **not relabeled** to bypass that check, so K3 imports containing its own assistant turns fail closed. Catalog availability does not guarantee that every model can import every session.

Cancellation while model discovery is pending ends that request before any runtime binding is prepared; shared discovery may finish for other requests, but its late result cannot resume the cancelled request or touch a newly selected session. Once prepared, cancellation belongs to the in-flight live run (including park-and-yield). SDK `process.reallyExit(0|1)` during teardown is swallowed so `/quit` does not throw `ExtensionExitError`.

Bootstrap budgeting reserves the model's output limit, framing overhead, and 4096 tokens per image in native user/developer history or send attachments (including required recovery tool-result images), then removes oldest complete history interaction units without splitting tool calls/results. Necessary system instructions and the current input are never silently truncated: oversized **text** fails before opening/resuming an agent. Recovery also retains its initiating request and completed interaction as one unit; image reserves can make that required unit exceed the budget. Image payload size is not treated as model tokens and does not by itself produce a context-overflow error. The text estimator deliberately counts UTF-8 bytes conservatively rather than claiming exact tokenization. Unknown model limits fail explicitly. Backend overflow is reported separately from quota/rate limits; no automatic retries or tool reexecution are added.

## Results, usage, and diagnostics

Final SDK results fill missing answer text against the current answer step. A matching prefix appends only the suffix; other mismatches replace that step's text instead of concatenating a second copy. Tools are not replayed. Public `run.usage` / `RunResult.usage` counters map into `usage.orchestration` (Run-deduplicated); prompt buckets stay zero. A high-water mark belongs to the SDK Run, so parked and cancelled returns report only newly observed usage, not the same cumulative counts again.

Assistant messages carry `cursorSdk` availability metadata: `tokenUsage` is `actual` or `unavailable`; `contextOccupancy` is `actual` with `source: "checkpoint"` after a successful settled turn whose public store root is new, idle, and stable, otherwise `unavailable`. Run billing and `turn-ended` totals are not occupancy. When occupancy is actual, `usage.contextTokens` is the checkpoint `usedTokens` value so OMP context accounting can use it; parked, cancelled, and unreadable checkpoints leave it unset. Message `cost` stays `unavailable`: OMP requires numeric cost fields, so their zero placeholders **do not mean free usage**. Official billed totals and dollar amounts come from `/cursor-usage` or OMP `/usage` (`agent.getUsage()`): top-level agent snapshots, not summed listed turns, and not written into `usage.cost`. Local billed IDs are per-turn identities, not SDK Run IDs, and costs can settle later. Some accounts return `feature_unavailable` for `getUsage()`. See the [public SDK usage contracts](https://cursor.com/docs/sdk/typescript#token-usage).

SDK Run billing maps to `usage.orchestration`: input includes cache writes, with output and cache reads in their own orchestration fields. The prompt buckets (`usage.input`, `output`, `cacheRead`, and `cacheWrite`) stay zero, and `usage.totalTokens` is the orchestration sum. OMP 18.1.14 subtracts orchestration from `calculateContextTokens` and checks only prompt input/cache buckets for usage-backed overflow, so cumulative Run totals no longer masquerade as conversation context. When a settled checkpoint reports occupancy, `calculateContextTokens` prefers `usage.contextTokens`.

Provider errors and diagnostic notifications redact credentials, authorization/cookie headers and sensitive query values before display/persistence, while retaining useful error categories and request IDs. Normal assistant/tool content is not globally rewritten.

## Development and verification

```bash
npm install
npm test
npm run typecheck
npm run check:boundaries
```

OMP packages are Bun-targeted, so runtime tests use Bun. GitHub Actions runs `npm ci`, typecheck, tests, `check:boundaries`, and `npm pack --dry-run` on every push and pull request.

Live SDK probes (requires `CURSOR_API_KEY`):

```bash
export CURSOR_API_KEY=...
npm run probe:sdk
```

The probe records that native `AgentOptions.systemPrompt` is omitted, imports a synthetic history token through the production importer, prefixes only its first imported-history send with the provider's shared `SDK_TOOL_CONTEXT`, checks one new custom-tool callback and its `toolCallId`, then verifies that `Agent.resume` retains the token without another tool execution.

Native-history smoke verification exercised the real provider and official SDK with synthetic OMP lifecycle hooks and session JSONL in isolated scratch, not the full OMP TUI or every model. Eight scenarios passed, covering native history continuation, one actual new-tool side effect, parked-result continuation on the same Agent, persisted resume retaining system/history, raw system-change reimport, cancelled parked Run followed by an isolated branch, compaction reimport, and completed screenshot-result recovery identifying blue/magenta/orange. This separate smoke is not part of the probe command above.

## Provenance and license

- Related independent-provider work: [lhq1412/omp-cursor-sdk](https://github.com/lhq1412/omp-cursor-sdk). This repository is a new local-runtime adapter, not a copy of that package's native+MCP loop.
- Repository code is MIT licensed; see [LICENSE](LICENSE). Copyright © 2026 lhq1412.
- OMP and `@cursor/sdk` are separate dependencies distributed under their own licenses and are not relicensed by this repository.
- Cursor is a trademark of Anysphere, Inc. This project is not affiliated with or endorsed by Anysphere.
