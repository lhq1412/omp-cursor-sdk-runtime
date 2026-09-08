# omp-cursor-sdk-runtime

OMP provider adapter for the official `@cursor/sdk` local agent runtime.

OMP owns sessions, permissions, tools, and UI. This package binds a local Cursor SDK agent onto the current OMP session leaf and executes tools only through the OMP host.

Pinned baselines:

- OMP `18.1.14` (`daf07999`)
- `@cursor/sdk` `1.0.31`

## Capability gap: no custom system prompt

Live probe against this account (2026-09-08) rejected `AgentOptions.systemPrompt` with:

```text
[invalid_argument] unknown option '--system-prompt'
```

v1 therefore **does not set `systemPrompt`**. OMP system instructions stay in the OMP session; they are not applied to the Cursor agent, and they are **not** copied into the user message. Cursor's built-in harness prompt remains in effect. This is a documented semantic gap, not an equivalent replacement of OMP's system prompt.

When the backend starts accepting `--system-prompt`, pass `systemPrompt` again on create and resume; do not invent a user-message fallback.

## Install into local OMP

```bash
npm install
omp plugin link .
```

OMP 18.1.14 only loads plugins declared in `~/.omp/plugins/package.json`. After linking, add a `file:` dependency if `omp models cursor-sdk` is empty:

```bash
cd ~/.omp/plugins
bun add /absolute/path/to/omp-cursor-sdk-runtime
```

Then `/login cursor-sdk` (or `CURSOR_API_KEY`) and select `cursor-sdk/composer-2.5`. Until OMP host patches land, this adapter still runs on stock brew OMP: `context.tools` plus xd://-mounted tools (including `mcp__*` MCP tools) are mapped to Cursor SDK custom tools so GetMcpTools/CallMcpTool can list and call them. Native Cursor executors stay disallowed. When the model calls a tool, the adapter emits OMP `toolUse`; OMP runs it with its own permissions/approval (MCP included via the xd:// fallback), then the next `streamSimple` resumes the parked SDK callbacks.

Restart `omp` after pulling adapter changes (the plugin is a symlink into this repo). Then:

```bash
omp --model cursor-sdk/composer-2.5
```

## Setup

```bash
npm install
npm test
npm run typecheck
npm run check:boundaries
```

Live SDK probes (requires `CURSOR_API_KEY`):

```bash
export CURSOR_API_KEY=...
npm run probe:sdk
```

The probe records the system-prompt gap, then checks custom-tool callbacks, `toolCallId`, and `Agent.resume` without that option.
