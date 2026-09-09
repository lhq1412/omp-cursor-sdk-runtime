export const CURSOR_SDK_PROVIDER_ID = "cursor-sdk";
export const CURSOR_SDK_API = "cursor-sdk-agent";
export const HOST_BRIDGE_VERSION = 1;
export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";
export const DEFAULT_MODEL_ID = "composer-2.5";
export const MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP = 20;

/**
 * Live probe (2026-09-08): this backend rejects `AgentOptions.systemPrompt`
 * with `[invalid_argument] unknown option '--system-prompt'`.
 * v1 never sets that field and never copies OMP system text into user messages.
 */
export const SYSTEM_PROMPT_REPLACEMENT = "unsupported" as const;

export const SDK_NATIVE_DISALLOWED_TOOLS = [
	"shell",
	"edit",
	"read",
	"grep",
	"glob",
	"ls",
	"delete",
	"task",
] as const;

export const FORBIDDEN_IMPORT_PATTERNS = [
	"providers/cursor.ts",
	"cursor-proto.ts",
	"cursor/exec-modern.ts",
	"@cursor/sdk/dist/internal",
] as const;

/** OMP JSONL custom entry used to resume a local Cursor SDK agent. */
export const CURSOR_SESSION_AGENT_RESUME_ENTRY_TYPE = "cursor-sdk-agent-resume";

export const DEFAULT_AGENT_INSTANCE_ID = "main";
