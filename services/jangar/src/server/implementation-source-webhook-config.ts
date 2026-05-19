type EnvSource = Record<string, string | undefined>

export type ImplementationSourceWebhookConfig = {
  namespacesRaw: string | null
  queueSize: number | null
  retryBaseDelaySeconds: number | null
  retryMaxDelaySeconds: number | null
  retryMaxAttempts: number | null
}

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

const readAgentsEnv = (env: EnvSource, name: string): string | undefined => env[name]

export const resolveImplementationSourceWebhookConfig = (
  env: EnvSource = process.env,
): ImplementationSourceWebhookConfig => ({
  namespacesRaw: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_NAMESPACES')),
  queueSize: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE'))
    ? Math.max(1, parsePositiveInt(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE'), 0))
    : null,
  retryBaseDelaySeconds: normalizeNonEmpty(
    readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_BASE_DELAY_SECONDS'),
  )
    ? Math.max(
        0,
        parsePositiveInt(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_BASE_DELAY_SECONDS'), 0),
      )
    : null,
  retryMaxDelaySeconds: normalizeNonEmpty(
    readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_DELAY_SECONDS'),
  )
    ? Math.max(
        0,
        parsePositiveInt(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_DELAY_SECONDS'), 0),
      )
    : null,
  retryMaxAttempts: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_ATTEMPTS'))
    ? Math.max(1, parsePositiveInt(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_ATTEMPTS'), 1))
    : null,
})
