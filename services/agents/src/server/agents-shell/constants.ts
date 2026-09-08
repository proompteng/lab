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
1. Treat /workspace/lab as the read-only seed checkout for direct ChatGPT sessions.
2. Start from fresh origin/main in a unique worktree:
   git -C /workspace/lab fetch origin main
   mkdir -p /workspace/worktrees/lab
   git -C /workspace/lab worktree add -B codex/<task-slug> /workspace/worktrees/lab/<branch-slug> origin/main
3. Use cwd: "worktrees/lab/<branch-slug>" for search, read_file, apply_patch, shell, git, tests, and any repo-local kubectl or gh command.
4. Never share a worktree or branch between concurrent ChatGPT sessions.
5. Do not edit /workspace/lab directly for multi-session work; only use it to fetch and create isolated worktrees.
6. Search with search, inspect with read_file and git, and make scoped edits with apply_patch.
7. Run focused tests, lint, type checks, or smoke commands that prove the change.
8. Commit as Greg Konush, push the branch, create a pull request with gh, and monitor CI.
9. Fix failures and continue until the task is complete, CI status is checked, and the PR URL is available.

Use shell_run for short commands. Use shell_start/read/status/kill for longer work. Default tool timeout is 60 seconds and the server cap is 1800 seconds. Git operations should use git or git_write; cluster operations should use kubectl or kubectl_admin. Do not use agent_start/status/read/cancel for direct multi-session ChatGPT work unless the user explicitly requests delegated AgentRun work. Report blockers only with exact tool calls, arguments, timestamps, server logs, audit entries, live environment state, and the layer that failed.`

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
