import { resolveFeatureFlagsClientConfig } from './integrations-config'

export type BooleanFlagRequest = {
  key: string
  defaultValue: boolean
}

export type BooleanFeatureToggleRequest = {
  fallbackEnvVar?: string
  key: string
  keyEnvVar?: string
  defaultValue: boolean
}

const TRUE_BOOLEAN_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const FALSE_BOOLEAN_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled'])

const readNonEmptyEnv = (value: string | undefined) => {
  if (!value) return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = readNonEmptyEnv(value)?.toLowerCase()
  if (!normalized) return fallback
  if (TRUE_BOOLEAN_VALUES.has(normalized)) return true
  if (FALSE_BOOLEAN_VALUES.has(normalized)) return false
  return fallback
}

const resolveBooleanFallback = (request: BooleanFeatureToggleRequest) => {
  if (!request.fallbackEnvVar) return request.defaultValue
  return parseBoolean(process.env[request.fallbackEnvVar], request.defaultValue)
}

const resolveFlagKey = (request: BooleanFeatureToggleRequest) => {
  const fromEnv = request.keyEnvVar ? readNonEmptyEnv(process.env[request.keyEnvVar]) : null
  return fromEnv || request.key
}

export const getBooleanFeatureFlag = async (request: BooleanFlagRequest): Promise<boolean> => {
  const key = request.key.trim()
  if (!key) return request.defaultValue

  const config = resolveFeatureFlagsClientConfig(process.env)
  if (!config.enabled || !config.endpoint) return request.defaultValue

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetch(`${config.endpoint}/evaluate/v1/boolean`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        namespaceKey: config.namespaceKey,
        flagKey: key,
        entityId: config.entityId,
        context: {},
      }),
      signal: controller.signal,
    })

    if (!response.ok) return request.defaultValue

    const body = (await response.json()) as { enabled?: unknown } | null
    return typeof body?.enabled === 'boolean' ? body.enabled : request.defaultValue
  } catch {
    return request.defaultValue
  } finally {
    clearTimeout(timeout)
  }
}

export const resolveBooleanFeatureToggle = async (request: BooleanFeatureToggleRequest): Promise<boolean> => {
  const defaultValue = resolveBooleanFallback(request)
  return getBooleanFeatureFlag({
    key: resolveFlagKey(request),
    defaultValue,
  })
}
