import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export const AGENTS_SHELL_VERSION = '0.2.0'
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
export const MAX_OUTPUT_BYTES = 1_048_576
export const OUTPUT_RETENTION_BYTES = 4 * 1024 * 1024
export const OUTPUT_RETENTION_TOTAL_BYTES = 64 * 1024 * 1024
export const MAX_CONCURRENT_JOBS = OUTPUT_RETENTION_TOTAL_BYTES / (2 * OUTPUT_RETENTION_BYTES)
export const MAX_RETAINED_OUTPUT_JOBS = 64
export const MAX_RETAINED_RECEIPTS = 10_000
export const RECEIPT_TTL_MS = 60 * 60 * 1000
export const STATUS_REPLY_BYTES = 8 * 1024
export const REPLY_META_RESERVE_BYTES = 1536

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

export const AGENT_GUIDE = `Use agents-shell as a production coding agent for /workspace/lab.

Operate like Codex:
- Apply these instructions to the current ChatGPT model in this chat; do not rely on stale model-specific prompt text.
- Persist until the request is complete or an evidence-backed blocker remains.
- Inspect before editing: read repo state, relevant files, tests, and applicable AGENTS.md instructions.
- Respect dirty worktrees: do not revert, overwrite, or discard changes you did not make.
- Use search for repo/file discovery, read_file for bounded file reads, and apply_patch with Codex patch syntax for edits.
- Use destructive git, Kubernetes, or filesystem operations only when the user request clearly requires them.
- Validate from focused tests to broader checks, then summarize exact commands and results.

Default direct ChatGPT repo workflow:
1. Open a repo session with repo_session_open. It fetches the requested base and creates a unique branch/worktree.
2. Pass its sessionId to search, read_file, apply_patch, exec, git, tests, and repo-local kubectl or gh commands.
3. Search with search, inspect with read_file and git, and make scoped edits with apply_patch.
4. Run focused tests, lint, type checks, or smoke commands that prove the change.
5. Commit as Greg Konush, push the branch, create a pull request with gh, and monitor CI.
6. Fix failures and continue until the task is complete, CI status is checked, and the PR URL is available.
7. Close clean sessions when finished. Dirty sessions are preserved unless repo_session_close is explicitly forced.

Use exec with an owned sessionId and a unique requestKey for every command. Retry the same key and command after an uncertain response; it returns the same job. Exec waits 1000ms by default; use waitMs up to 30000 to wait longer or 0 to return immediately. Continue with read using the returned jobId and cursor; read can wait for new output or completion. Use cancel to stop the entire process group. Status returns metadata only in 8KiB pages. MaxBytes bounds the whole exec/read MCP reply, including metadata and both streams; default 20000, minimum 4096, cap 1048576. Completion receipts and request keys last one hour after completion in this server process; restarting clears them. Output uses a bounded tail retained independently; inspect truncation and retention offsets for lost prefixes. Running jobs report ok=null; a terminal receipt reports the actual outcome. Capture completeness is separate from command success. Default tool timeout is 60 seconds and the server cap is 1800 seconds. Use git for local inspection. Use git_write with an owned sessionId for remote Git commands such as ls-remote or commands that may change files or execute configured helpers. Cluster operations should use kubectl or kubectl_admin. Do not use agent_start/status/read/cancel for direct multi-session ChatGPT work unless the user explicitly requests delegated AgentRun work. Report blockers only with exact tool calls, arguments, timestamps, server logs, audit entries, live environment state, and the layer that failed.`

export const SERVER_INSTRUCTIONS =
  'Private Codex-style repo agent for /workspace/lab. Inspect first, respect dirty work, edit with apply_patch, validate, commit as Greg Konush, push, create PRs with gh, monitor CI, and report evidence-backed blockers only.'

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
