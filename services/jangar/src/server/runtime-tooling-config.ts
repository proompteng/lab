import { join } from 'node:path'

type EnvSource = Record<string, string | undefined>

const DEFAULT_PYTHON_BIN = 'python3'
const DEFAULT_WORKTREE = '/workspace/lab'
const DEFAULT_HTTP_TIMEOUT_MS = 2_000

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parseOptionalJsonRecord = (value: string | undefined) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return {}
  try {
    const parsed = JSON.parse(normalized) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const output: Record<string, string> = {}
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (raw == null) continue
      output[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
    }
    return output
  } catch {
    return {}
  }
}

export type RuntimeAdmissionConfig = {
  worktree: string
  natsUrl: string
  pythonBin: string
  runtimeImage: string
  pathEntries: string[]
}

export type TerminalRuntimeConfig = {
  scriptBin: string | null
  ptyMode: string
  shell: string
}

export type CodexClientConfig = {
  mcpUrl: string
  binaryPath: string
}

export type GitLockRecoveryConfig = {
  staleMs: number
  prStaleMs: number
  retryAttempts: number
  retryDelayMs: number
}

export type AuditSinkConfig = {
  type: 'none' | 'stdout' | 'http'
  url: string | null
  timeoutMs: number
  headers: Record<string, string>
}

export type BumbaRuntimeConfig = {
  repositoryHint: string | null
  workspaceRoot: string
  taskQueue: string
}

export type RepoWorkspaceConfig = {
  repoRoot: string
}

export type MockCodexConfig = {
  enabled: boolean
  scenario: string
}

export const resolveRuntimeAdmissionConfig = (env: EnvSource = process.env): RuntimeAdmissionConfig => ({
  worktree: normalizeNonEmpty(env.WORKTREE) ?? (process.cwd().trim() || DEFAULT_WORKTREE),
  natsUrl: normalizeNonEmpty(env.NATS_URL) ?? normalizeNonEmpty(env.natsUrl) ?? '',
  pythonBin: normalizeNonEmpty(env.PYTHON_BIN) ?? normalizeNonEmpty(env.PYTHON) ?? DEFAULT_PYTHON_BIN,
  runtimeImage:
    normalizeNonEmpty(env.JANGAR_RUNTIME_IMAGE) ??
    normalizeNonEmpty(env.JANGAR_IMAGE) ??
    normalizeNonEmpty(env.IMAGE_REF) ??
    'runtime:local',
  pathEntries: (env.PATH ?? '').split(':').filter((entry) => entry.length > 0),
})

export const resolveTerminalRuntimeConfig = (env: EnvSource = process.env): TerminalRuntimeConfig => ({
  scriptBin: normalizeNonEmpty(env.SCRIPT_BIN),
  ptyMode: (normalizeNonEmpty(env.JANGAR_PTY_MODE) ?? '').toLowerCase(),
  shell: normalizeNonEmpty(env.SHELL) ?? '/bin/bash',
})

export const resolveCodexClientConfig = (env: EnvSource = process.env): CodexClientConfig => {
  const port = normalizeNonEmpty(env.UI_PORT) ?? normalizeNonEmpty(env.PORT) ?? '8080'
  return {
    mcpUrl: normalizeNonEmpty(env.JANGAR_MCP_URL) ?? `http://127.0.0.1:${port}/mcp`,
    binaryPath: normalizeNonEmpty(env.JANGAR_CODEX_BINARY) ?? 'codex',
  }
}

export const resolveGitLockRecoveryConfig = (env: EnvSource = process.env): GitLockRecoveryConfig => {
  const staleMs = parsePositiveInt(env.JANGAR_GIT_LOCK_STALE_MS, 2 * 60 * 1000)
  return {
    staleMs,
    prStaleMs: parsePositiveInt(env.JANGAR_GIT_PR_LOCK_STALE_MS, staleMs),
    retryAttempts: parsePositiveInt(env.JANGAR_GIT_LOCK_RETRY_ATTEMPTS, 3),
    retryDelayMs: parsePositiveInt(env.JANGAR_GIT_LOCK_RETRY_DELAY_MS, 750),
  }
}

export const resolveAuditSinkConfig = (env: EnvSource = process.env): AuditSinkConfig => {
  const rawType = normalizeNonEmpty(env.JANGAR_AUDIT_SINK_TYPE)?.toLowerCase() ?? 'none'
  const type: AuditSinkConfig['type'] = rawType === 'stdout' || rawType === 'http' ? rawType : 'none'
  return {
    type,
    url: normalizeNonEmpty(env.JANGAR_AUDIT_SINK_HTTP_URL),
    timeoutMs: parsePositiveInt(env.JANGAR_AUDIT_SINK_HTTP_TIMEOUT_MS, DEFAULT_HTTP_TIMEOUT_MS),
    headers: parseOptionalJsonRecord(env.JANGAR_AUDIT_SINK_HTTP_HEADERS_JSON),
  }
}

const normalizeRepositoryHint = (value: string) =>
  value
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, '')
    .replace(/^ssh:\/\/git@github\.com\//, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/^github\.com\//, '')

export const resolveBumbaRuntimeConfig = (env: EnvSource = process.env): BumbaRuntimeConfig => {
  const repositoryHint =
    normalizeNonEmpty(env.CODEX_REPO_SLUG) ?? normalizeNonEmpty(env.REPOSITORY) ?? normalizeNonEmpty(env.CODEX_REPO_URL)
  return {
    repositoryHint: repositoryHint ? normalizeRepositoryHint(repositoryHint) : null,
    workspaceRoot: normalizeNonEmpty(env.BUMBA_WORKSPACE_ROOT) ?? resolveRepoWorkspaceConfig(env).repoRoot,
    taskQueue: normalizeNonEmpty(env.JANGAR_BUMBA_TASK_QUEUE) ?? normalizeNonEmpty(env.TEMPORAL_TASK_QUEUE) ?? 'bumba',
  }
}

export const resolveRepoWorkspaceConfig = (env: EnvSource = process.env): RepoWorkspaceConfig => ({
  repoRoot: normalizeNonEmpty(env.CODEX_CWD) ?? normalizeNonEmpty(env.VSCODE_DEFAULT_FOLDER) ?? process.cwd(),
})

export const resolveMockCodexConfig = (env: EnvSource = process.env): MockCodexConfig => {
  const scenario = normalizeNonEmpty(env.JANGAR_MOCK_CODEX_SCENARIO) ?? 'openwebui-e2e'
  return {
    enabled: parseBoolean(env.JANGAR_MOCK_CODEX, false) || normalizeNonEmpty(env.JANGAR_MOCK_CODEX_SCENARIO) != null,
    scenario,
  }
}

export const resolveCodexNatsHelperPathCandidatesFromConfig = (
  config: RuntimeAdmissionConfig,
  command: 'codex-nats-publish' | 'codex-nats-soak',
  cwd = process.cwd(),
) => [
  join(cwd, 'services', 'agents', 'scripts', 'codex', `${command}.ts`),
  join(cwd, 'scripts', `${command}.ts`),
  join(config.worktree, 'services', 'agents', 'scripts', 'codex', `${command}.ts`),
  join('/usr/local/bin', command),
]

export const validateRuntimeToolingConfig = (env: EnvSource = process.env) => {
  resolveRuntimeAdmissionConfig(env)
  resolveTerminalRuntimeConfig(env)
  resolveCodexClientConfig(env)
  resolveGitLockRecoveryConfig(env)
  resolveAuditSinkConfig(env)
  resolveBumbaRuntimeConfig(env)
  resolveRepoWorkspaceConfig(env)
  resolveMockCodexConfig(env)
}
