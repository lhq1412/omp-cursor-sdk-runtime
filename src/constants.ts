export const CURSOR_SDK_PROVIDER_ID = "cursor-sdk";
export const CURSOR_SDK_API = "cursor-sdk-agent";
export const HOST_BRIDGE_VERSION = 1;
export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";
export const DEFAULT_MODEL_ID = "composer-2.5";

/** OMP context-maintenance reserve; advertised model.maxTokens can be 64k. */
export const BOOTSTRAP_OUTPUT_RESERVE_TOKENS = 16_384;

export const SDK_TOOL_CONTEXT = "Cursor SDK tool access: use the custom-user-tools namespace for any tools granted in this run. Discover their schemas before invoking them. Native Cursor tools are unavailable. Do not call FetchMcpResource or readMcpResource; memory uses granted mcp__* tools or read memory://.";
export const SDK_TOOL_CONTEXT_WITH_READ = "Cursor SDK tool access: native `read`, `grep`, `shell`, `edit`, `piWrite`, `glob`, and `ls` are available. Other native Cursor tools are unavailable. Use the custom-user-tools namespace for remaining granted tools. Discover their schemas before invoking them. Do not call FetchMcpResource or readMcpResource; memory uses granted mcp__* tools or read memory://.";

/**
 * Live probe (2026-09-08): this backend rejects `AgentOptions.systemPrompt`
 * with `[invalid_argument] unknown option '--system-prompt'`.
 * Native replacement stays unsupported; never set AgentOptions.systemPrompt.
 * Bootstrap send text may include sanitized OMP instructions; incremental turns
 * omit them because the existing agent retains bootstrap.
 */
export const SYSTEM_PROMPT_REPLACEMENT = "unsupported" as const;

export const SDK_NATIVE_DISALLOWED_TOOLS = [
	"shell",
	"edit",
	"read",
	"grep",
	"glob",
	"ls",
	"piWrite",
	"delete",
	"task",
	"readMcpResource",
	"listMcpResources",
] as const;

export const FORBIDDEN_IMPORT_PATTERNS = [
	"@oh-my-pi/pi-ai/providers/cursor",
	"@oh-my-pi/pi-catalog/discovery/cursor-proto",
	"@oh-my-pi/pi-catalog/discovery/protobuf",
	"providers/cursor.ts",
	"cursor-proto.ts",
	"cursor/exec-modern.ts",
	"@cursor/sdk/dist/internal",
] as const;

/** OMP JSONL custom entry used to resume a local Cursor SDK agent. */
export const CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE = "cursor-sdk-agent-resume";

export const DEFAULT_AGENT_INSTANCE_ID = "main";
