type EnvSource = Record<string, string | undefined>

const DEFAULT_FEATURE_FLAGS_TIMEOUT_MS = 500
const DEFAULT_FEATURE_FLAGS_NAMESPACE = 'default'
const DEFAULT_FEATURE_FLAGS_ENTITY_ID = 'jangar'

const TRUE_BOOLEAN_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const FALSE_BOOLEAN_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled'])

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (TRUE_BOOLEAN_VALUES.has(normalized)) return true
  if (FALSE_BOOLEAN_VALUES.has(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

export type FeatureFlagsClientConfig = {
  enabled: boolean
  endpoint: string | null
  timeoutMs: number
  namespaceKey: string
  entityId: string
}

export const resolveFeatureFlagsClientConfig = (env: EnvSource = process.env): FeatureFlagsClientConfig => ({
  enabled: parseBoolean(env.JANGAR_FEATURE_FLAGS_ENABLED, true),
  endpoint: normalizeNonEmpty(env.JANGAR_FEATURE_FLAGS_URL)?.replace(/\/+$/, '') ?? null,
  timeoutMs: parsePositiveInt(env.JANGAR_FEATURE_FLAGS_TIMEOUT_MS, DEFAULT_FEATURE_FLAGS_TIMEOUT_MS),
  namespaceKey: normalizeNonEmpty(env.JANGAR_FEATURE_FLAGS_NAMESPACE) ?? DEFAULT_FEATURE_FLAGS_NAMESPACE,
  entityId: normalizeNonEmpty(env.JANGAR_FEATURE_FLAGS_ENTITY_ID) ?? DEFAULT_FEATURE_FLAGS_ENTITY_ID,
})

export const validateIntegrationsConfig = (env: EnvSource = process.env) => {
  const featureFlags = resolveFeatureFlagsClientConfig(env)
  if (featureFlags.endpoint) {
    try {
      new URL(featureFlags.endpoint)
    } catch {
      throw new Error(`JANGAR_FEATURE_FLAGS_URL is invalid: ${featureFlags.endpoint}`)
    }
  }
}
