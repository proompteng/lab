type EnvSource = Record<string, string | undefined>

const DEFAULT_BACKEND_TIMEOUT_MS = 15_000
const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000
const DEFAULT_WORKTREE_TIMEOUT_MS = 180_000

export type TerminalBackendConfig = {
  backendUrl: string | null
  timeoutMs: number
}

export type TerminalsConfig = {
  baseRef: string
  mainFetchEnabled: boolean
  worktreeTimeoutMs: number
  deferWorktreeCheckout: boolean
  bufferBytes: number
  idleTimeoutMs: number
  publicTerminalUrl: string | null
  codexCwdOverride: string | null
  backendId: string | null
  isProduction: boolean
}

const parsePositiveInteger = (name: string, value: string | undefined, fallback: number) => {
  if (!value?.trim()) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export const resolveTerminalBackendConfig = (env: EnvSource = process.env): TerminalBackendConfig => ({
  backendUrl: env.JANGAR_TERMINAL_BACKEND_URL?.trim() || null,
  timeoutMs: parsePositiveInteger(
    'JANGAR_TERMINAL_BACKEND_TIMEOUT_MS',
    env.JANGAR_TERMINAL_BACKEND_TIMEOUT_MS,
    DEFAULT_BACKEND_TIMEOUT_MS,
  ),
})

export const resolveTerminalsConfig = (env: EnvSource = process.env): TerminalsConfig => ({
  baseRef: env.JANGAR_TERMINAL_BASE_REF?.trim() || 'origin/main',
  mainFetchEnabled: parseBoolean(env.JANGAR_TERMINAL_FETCH_MAIN, true),
  worktreeTimeoutMs: parsePositiveInteger(
    'JANGAR_TERMINAL_WORKTREE_TIMEOUT_MS',
    env.JANGAR_TERMINAL_WORKTREE_TIMEOUT_MS,
    DEFAULT_WORKTREE_TIMEOUT_MS,
  ),
  deferWorktreeCheckout: parseBoolean(env.JANGAR_TERMINAL_DEFER_CHECKOUT, true),
  bufferBytes: parsePositiveInteger(
    'JANGAR_TERMINAL_BUFFER_BYTES',
    env.JANGAR_TERMINAL_BUFFER_BYTES,
    DEFAULT_BUFFER_BYTES,
  ),
  idleTimeoutMs: parsePositiveInteger(
    'JANGAR_TERMINAL_IDLE_TIMEOUT_MS',
    env.JANGAR_TERMINAL_IDLE_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
  ),
  publicTerminalUrl: env.JANGAR_TERMINAL_PUBLIC_URL?.trim() || null,
  codexCwdOverride: env.CODEX_CWD?.trim() || null,
  backendId: env.JANGAR_TERMINAL_BACKEND_ID?.trim() || null,
  isProduction: env.NODE_ENV === 'production',
})

export const validateTerminalsConfig = (env: EnvSource = process.env) => {
  resolveTerminalBackendConfig(env)
  resolveTerminalsConfig(env)
}

export const __private = {
  parseBoolean,
  parsePositiveInteger,
}
