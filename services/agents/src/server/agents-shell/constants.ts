import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export const AGENTS_SHELL_VERSION = '0.3.0'
export const DEFAULT_RESOURCE = 'https://agents-shell.proompteng.ai'
export const DEFAULT_ISSUER = 'https://auth.proompteng.ai/realms/master'
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
export const DEFAULT_REPO_BASE_BRANCH = 'main'
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
- Infrastructure inspection uses the read-only infrastructure tool with command=talosctl or command=omnictl, without a repo session. Pass the verb first in args. Talos node targets are Omni machine UUIDs. The dedicated Omni Reader identity cannot mutate cluster state or read protected files; do not replace it with operator credentials.

Default direct ChatGPT repo workflow:
1. Open a repo session with repo_session_open. It fetches the requested base and creates a unique branch/worktree.
2. Pass its sessionId to search, read_file, apply_patch, exec, git, tests, and repo-local kubectl or gh commands.
3. Search with search, inspect with read_file and git, and make scoped edits with apply_patch.
4. Run focused tests, lint, type checks, or smoke commands that prove the change.
5. Commit as Greg Konush, push the branch, create a pull request with gh, and monitor CI.
6. Fix failures and continue until the task is complete, CI status is checked, and the PR URL is available.
7. Close clean sessions when finished. Dirty sessions are preserved unless repo_session_close is explicitly forced.

For read-only repository investigations, inspect shared /workspace/lab without opening a session. Its refs may be cached; report that limitation. Managed worktrees belong to the subject that opened them. A path from git worktree list does not grant access. On REPO_SESSION_FORBIDDEN, skip that worktree and use your own sessionId or the shared read-only checkout; do not retry another subject's paths. Git branch inspection always lists branches, including bare name patterns. Use git_write with your owned session for branch creation or changes.

Use exec with an owned sessionId and a unique requestKey for every command. Keep the original exec arguments for retries. Reuse the same sessionId and requestKey with the same command, cwd, timeoutSeconds and agentId; it returns the same job. WaitMs, maxBytes and outputEncoding may change. Completed replay still works after the session closes. A commandPreview may be truncated and cannot reconstruct the original command. Exec waits 1000ms by default; use waitMs up to 30000 to wait longer or 0 to return immediately. Continue with read using the returned jobId and cursor; read can wait for new output or completion. Use cancel to stop the entire process group. Status returns metadata in 8KiB pages, including bounded commandPreview and commandHash but no stdout/stderr. A short command can fit entirely in its preview. MaxBytes bounds the whole exec/read MCP reply, including metadata and both streams; default 20000, minimum 4096, cap 1048576. Completion receipts and request keys last one hour after completion in this server process; restarting clears them. Output uses a bounded tail retained independently; inspect truncation and retention offsets for lost prefixes. Running jobs report ok=null; a terminal receipt reports the actual outcome. Capture completeness is separate from command success. Default tool timeout is 60 seconds and the server cap is 1800 seconds. Use git for local inspection. Use git_write with an owned sessionId for remote Git commands such as ls-remote or commands that may change files or execute configured helpers. Cluster operations should use kubectl or kubectl_admin. In Kubernetes, startup configures an in-cluster context using the mounted ServiceAccount when no kubeconfig already exists. Delegated AgentRun work uses the canonical create_agent_run, get_agent_run, get_agent_run_logs and cancel_agent_run tools. Use these only when the user requests delegated workers. Keep one stable deliveryId when retrying an uncertain submission, including after reconnecting. Put the complete task in payload.implementation.text, the objective in payload.goal.objective, and runtime.type=job. Omit goal.tokenBudget unless the user requests a token budget. For repository work provide parameters.repository/base/head, vcsRef, secrets and secretBindingRef=codex-github-token. Creating a run is asynchronous; return its durable projection id and inspect get_agent_run until the requested outcome is terminal. A Kubernetes Job or successful submission is not proof that the requested work succeeded. Include the final test, commit, PR and artifact evidence. Report blockers only with exact tool calls, arguments, timestamps, server logs, audit entries, live environment state, and the layer that failed.`

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
