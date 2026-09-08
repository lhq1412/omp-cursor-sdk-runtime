# OMP host bridge (optional)

Pinned host: OMP **18.1.14** (`daf07999`).

Brew `omp` 18.1.14 does **not** inject `ompCursorRuntimeHost` into `streamSimple` options. This adapter therefore runs on stock OMP by mapping `context.tools` to Cursor SDK custom tools and parking each `execute()` until the OMP agent loop runs the tool (permissions, approval, UI) and the next `streamSimple` resumes the parked callbacks.

## Optional patch (not required for local testing)

If you rebuild OMP from `oh-my-pi`, you can pass an `OmpHostBridgeV1` on stream options under `ompCursorRuntimeHost`:

- `version: 1`
- `snapshot()` — session id, `agentInstanceId`, cwd, granted tools, effective context
- `executeTool(name, args, toolCallId)` — grant-only; same once-only marker as the adapter (`bridgeRunId + toolCallId`)
- `flushToolResults()`
- `commitBinding(binding)`
- `signal`

When the host is present, tools execute inside `Agent.send()` and the adapter does not emit `toolUse` for OMP to re-run.

Call site to patch: `packages/coding-agent/src/config/model-registry.ts` `registerCustomApi` / the coding-agent stream options object.
