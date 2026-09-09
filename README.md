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

The extension exposes models only through OMP's `fetchDynamicModels` path: live SDK rows when a key is available, otherwise the fallback `composer-2.5` row.

```bash
omp --model cursor-sdk/composer-2.5
```

Cloud `bc-*` agent ids are rejected. Local runtime is the only supported runtime.

## Tools

On stock brew OMP, `context.tools` plus xd://-mounted tools (including enabled `mcp__*` MCP tools) are mapped to Cursor SDK custom tools. Native Cursor executors (`shell`, `edit`, `read`, `grep`, `glob`, `ls`, `delete`, `task`) stay disallowed. SDK `settingSources` is always `[]`; `mcpServers` is always `{}`.

When the model calls a tool, the adapter emits OMP `toolUse`, parks the SDK callbacks, and yields back to OMP. OMP runs the tool with its own permissions and approval (MCP included via the xd:// fallback). The next `streamSimple` resumes the parked callbacks with the trailing `toolResult`s.

An explicit host grant is used as-is. Stock extras only add currently enabled `mcp__*` names; an empty or read-only grant stays empty.

## Capability gap: no custom system prompt

Live probe against this account (2026-09-08) rejected `AgentOptions.systemPrompt` with:

```text
[invalid_argument] unknown option '--system-prompt'
```

v1 therefore **does not set `systemPrompt`**. OMP system instructions stay in the OMP session; they are not applied to the Cursor agent, and they are **not** copied into the user message. Cursor's built-in harness prompt remains in effect. This is a documented semantic gap, not an equivalent replacement of OMP's system prompt.

When the backend starts accepting `--system-prompt`, pass `systemPrompt` again on create and resume; do not invent a user-message fallback.

## Session behavior

Local agents are bound to the current OMP JSONL session leaf, cwd, and credential identity. Same-session incremental turns reuse the agent. New agents reconstruct prior visible OMP history into the current user input (no system prompt). Resume records persist the agent's execution cwd; a matching committed handle can be resumed after process restart. Branch navigation, compaction, failed turns, and cwd/key changes start a new agent.

Cancel belongs to the in-flight live run (including park-and-yield). SDK `process.reallyExit(0|1)` during teardown is swallowed so `/quit` does not throw `ExtensionExitError`.

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

The probe records the system-prompt gap, then checks custom-tool callbacks, `toolCallId`, and `Agent.resume` without that option.

## Provenance and license

- Related independent-provider work: [lhq1412/omp-cursor-sdk](https://github.com/lhq1412/omp-cursor-sdk). This repository is a new local-runtime adapter, not a copy of that package's native+MCP loop.
- Repository code is MIT licensed; see [LICENSE](LICENSE). Copyright © 2026 lhq1412.
- OMP and `@cursor/sdk` are separate dependencies distributed under their own licenses and are not relicensed by this repository.
- Cursor is a trademark of Anysphere, Inc. This project is not affiliated with or endorsed by Anysphere.
