type EnvSource = Record<string, string | undefined>

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

export type AgentsListenConfig = {
  port: number
  hostname: string
  idleTimeoutSeconds: number
}

export const resolveAgentsHttpServerListenConfig = (env: EnvSource = process.env): AgentsListenConfig => ({
  port: parsePositiveInt(env.PORT ?? env.AGENTS_PORT ?? env.JANGAR_PORT, 3000),
  hostname: normalizeNonEmpty(env.HOST) ?? '0.0.0.0',
  idleTimeoutSeconds: parsePositiveInt(
    env.AGENTS_HTTP_IDLE_TIMEOUT_SECONDS ?? env.JANGAR_HTTP_IDLE_TIMEOUT_SECONDS,
    120,
  ),
})

export const validateRuntimeEntryConfig = (env: EnvSource = process.env) => {
  resolveAgentsHttpServerListenConfig(env)
}
