# omp-cursor-sdk-runtime

Independent [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) provider adapter for the official `@cursor/sdk` **local** agent runtime.

The extension registers models under **`cursor-sdk/*`**. It does not replace, modify, or reuse OMP's built-in **`cursor/*`** provider.

OMP owns sessions, permissions, tools, and UI. This package binds a local Cursor SDK agent onto the current OMP session leaf and executes tools only through the OMP host. Native Cursor executors stay disallowed.

This is a separate adapter from [lhq1412/omp-cursor-sdk](https://github.com/lhq1412/omp-cursor-sdk). That package keeps Cursor's native agent loop and optional Cloud; this package uses SDK local in-process runtime with a park-and-yield tool loop so stock brew OMP can approve and run tools.

Pinned baselines:

- OMP `18.1.14` (`daf07999`)
- `@cursor/sdk` `1.0.31`

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

```bash
omp --model cursor-sdk/composer-2.5
omp --model cursor-sdk/gpt-5.5:xhigh  # when this model/effort is in your live catalog
```

Thinking uses native OMP `:level` suffixes and the thinking selector (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), limited to each model's advertised capabilities. Composer's fallback has fast but no thinking selector. Extended context uses native `/extended-context [on|off|status]` or Settings → Extended Context. Exactly two numeric context tiers share one model row; three or more tiers retain explicit non-default `@context` rows. Runtime maps the host-clamped `model.contextWindow` to the SDK context parameter.

In-session:

- `/cursor-fast [on|off|status]` — per canonical model; `--cursor-no-fast` wins `--cursor-fast`; otherwise session custom entries. Takes effect on the next new send, not an in-flight parked run.
- `/cursor-refresh-models` — requires a Cursor SDK key and calls native `modelRegistry.refreshProvider("cursor-sdk", "online")`. Success requires a successful live discovery callback, not a silently reused cache; failures retain the previous catalog. `omp models refresh` also goes through `fetchDynamicModels`.

Raw SDK parameter metadata is hydrated once per credential when OMP serves cached model rows. `/cursor-fast` works offline for the known `composer-2.5` fallback; other models require known capabilities and fail clearly if discovery is unavailable. Authentication uses the `cursor-sdk` provider key with `CURSOR_API_KEY` fallback; credential-scoped metadata cannot leak between accounts. Empty live catalogs are errors, not successful refreshes. Cloud `bc-*` agent IDs remain rejected.

## Tools

On stock brew OMP, `context.tools` plus xd://-mounted tools (including enabled `mcp__*` MCP tools) are mapped to Cursor SDK custom tools. Native Cursor executors (`shell`, `edit`, `read`, `grep`, `glob`, `ls`, `delete`, `task`) stay disallowed. SDK `settingSources` is always `[]`; `mcpServers` is always `{}`.

When the model calls a tool, the adapter emits OMP `toolUse`, parks the SDK callbacks, and yields back to OMP. OMP runs the tool with its own permissions and approval (MCP included via the xd:// fallback). The next `streamSimple` resumes the parked callbacks with the trailing `toolResult`s.

An explicit host grant is used as-is. Stock extras only add currently enabled `mcp__*` names; an empty or read-only grant stays empty.

## Capability gap: native `systemPrompt` unsupported

Live probe against this account (2026-09-08) rejected `AgentOptions.systemPrompt` with:

```text
[invalid_argument] unknown option '--system-prompt'
```

v1 therefore **does not set `systemPrompt`**. Cursor's built-in harness prompt remains in effect. That native system-role option is unused; sanitized bootstrap text is not a replacement for it.

A **fresh bootstrap** prepends sanitized OMP system instructions when nonempty to send text as:

```text
System instructions from OMP:
${sanitized}
```

then prior visible history and the current user turn (including a first user turn). Incremental rounds omit that prefix; the existing agent already has it from bootstrap. Empty or missing system text leaves history/images-only behavior unchanged. `activeUserInput` stays the current user turn only. The reuse fingerprint still uses the raw system text, so a system change forces a fresh bootstrap.

Sanitizer (`serializeSystemPrompt` joins `string | string[]` with newlines):

- If the prompt does not start with `<system-conventions>`, use it trimmed.
- Else find `\n# Internal URLs\n`, then `\n§ Workflow\n` after it. If either marker is missing, use the trimmed prompt.
- Else join with `\n\n`: the prefix before Internal URLs (`trimEnd`), the literal `OMP host tool catalog and tool policy omitted: Cursor can call only Cursor SDK tools exposed in this run.`, and the Workflow suffix (`trimStart`).

## Session behavior

Local agents are bound to the current OMP JSONL session leaf, cwd, and credential identity. Same-session incremental turns reuse the agent and send only the current user input. A new agent bootstraps with sanitized OMP system instructions when nonempty, plus reconstructed visible history and the current turn. Resume records persist the agent's execution cwd; a matching committed handle can be resumed after process restart. Branch navigation, compaction, failed turns, and cwd/key changes start a new agent.

Cancellation while model discovery is pending ends that request before any runtime binding is prepared; shared discovery may finish for other requests, but its late result cannot resume the cancelled request or touch a newly selected session. Once prepared, cancellation belongs to the in-flight live run (including park-and-yield). SDK `process.reallyExit(0|1)` during teardown is swallowed so `/quit` does not throw `ExtensionExitError`.

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

The probe records that native `AgentOptions.systemPrompt` is omitted, then checks custom-tool callbacks, `toolCallId`, and `Agent.resume` without that option.

## Provenance and license

- Related independent-provider work: [lhq1412/omp-cursor-sdk](https://github.com/lhq1412/omp-cursor-sdk). This repository is a new local-runtime adapter, not a copy of that package's native+MCP loop.
- Repository code is MIT licensed; see [LICENSE](LICENSE). Copyright © 2026 lhq1412.
- OMP and `@cursor/sdk` are separate dependencies distributed under their own licenses and are not relicensed by this repository.
- Cursor is a trademark of Anysphere, Inc. This project is not affiliated with or endorsed by Anysphere.
