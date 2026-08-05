import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export const AGENTS_SHELL_VERSION = '0.1.0'
export const DEFAULT_RESOURCE = 'https://agents-shell.proompteng.ai'
export const DEFAULT_ISSUER = 'https://auth.proompteng.ai/realms/master'
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
export const DEFAULT_AGENT_NAMESPACE = 'agents'
export const DEFAULT_AGENT_NAME = 'codex-agent'
export const DEFAULT_AGENT_REPOSITORY = 'proompteng/lab'
export const DEFAULT_AGENT_BASE_BRANCH = 'main'
export const DEFAULT_AGENT_VCS_REF = 'github'
export const DEFAULT_AGENT_RUNTIME_SERVICE_ACCOUNT = 'agents-sa'
export const DEFAULT_AGENT_SECRETS = ['github-token', 'codex-auth']
export const DEFAULT_AGENT_TOKEN_BUDGET = 250_000
export const DEFAULT_AGENT_TTL_SECONDS_AFTER_FINISHED = 86_400
export const DEFAULT_TIMEOUT_SECONDS = 60
export const MAX_TIMEOUT_SECONDS = 1800
export const DEFAULT_OUTPUT_BYTES = 20_000
export const MAX_OUTPUT_BYTES = 200_000
// The complete untruncated tools/list payload measures 19,706 bytes. Keep a visible 24 KiB contract ceiling
// (4,870 bytes / 24.7% headroom) and fail startup if the measured payload grows beyond it.
export const DEFAULT_MAX_TOOL_SCHEMA_BYTES = 24_576

export const DEFAULT_WORKSPACE_SEARCH_EXCLUDES = [
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor',
  '.venv',
  'venv',
  'schemas/custom',
]

export const AGENT_GUIDE = `Use agents-shell as a production coding agent with one server-issued workspace lease per MCP session.

Operate like Codex:
- Apply these instructions to the current ChatGPT model in this chat; do not rely on stale model-specific prompt text.
- Persist until the request is complete or an evidence-backed blocker remains.
- Inspect before editing: read repo state, relevant files, tests, and applicable AGENTS.md instructions.
- Respect dirty worktrees: do not revert, overwrite, or discard changes you did not make.
- Use search for repo/file discovery, read_file for bounded file reads, and apply_patch with Codex patch syntax for edits.
- Use destructive git, Kubernetes, or filesystem operations only when the user request clearly requires them.
- Validate from focused tests to broader checks, then summarize exact commands and results.

Default direct ChatGPT repo workflow:
1. Treat /workspace/lab as a shared read-only seed. Never mutate, stash, commit, reset, or clean it.
2. Before any mutation, call workspace_acquire with a task name and optional exact expected commit. The server creates or adopts exactly one unique contained workspace and binds it to this unforgeable MCP session.
3. Use paths relative to the leased workspace. Mutating tools fail closed without an active lease and cannot enter another session's workspace.
4. Inspect with search, read_file, and git; edit with apply_patch; run commands with shell tools; use git_write only for repository changes.
5. Long-running jobs remain bound to the lease and are terminated if the session or lease is revoked or expires.
6. Run focused tests, lint, type checks, or smoke commands that prove the change.
7. Commit as Greg Konush, push the branch, create a pull request with gh, and monitor CI.
8. Fix failures and continue until the task is complete, CI status is checked, and the PR URL is available.

Use shell_run for short commands. Use shell_start/read/status/kill for longer work. Default tool timeout is 60 seconds and the server cap is 1800 seconds. Git operations should use git or git_write; cluster operations should use kubectl or kubectl_admin. Do not use agent_start/status/read/cancel for direct multi-session ChatGPT work unless the user explicitly requests delegated AgentRun work. Report blockers only with exact tool calls, arguments, timestamps, server logs, audit entries, live environment state, and the layer that failed.`

export const SERVER_INSTRUCTIONS =
  'Private Codex-style repo agent. /workspace/lab is a read-only shared seed. Acquire one server-issued workspace lease before mutations; use only that workspace, inspect first, preserve dirty work, validate, commit, push, create PRs, and report evidence-backed blockers.'

export const SCOPES = {
  read: 'agents-shell.read',
  write: 'agents-shell.write',
  admin: 'agents-shell.admin',
  offlineAccess: 'offline_access',
} as const

export const READ_SCOPES = [SCOPES.read, SCOPES.write, SCOPES.admin]
export const CONNECTOR_LINK_SCOPES = [SCOPES.offlineAccess]
// ChatGPT connector sessions are private and identity-allowlisted. Keep tool authorization on the stable
// linked scope so long-running workflows do not re-enter OAuth when they move from read tools to write tools.
export const WRITE_SCOPES = READ_SCOPES

export const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
}

export const openReadOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
}

export const writeAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
}

export const shellAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
}

export const destructiveAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
}
