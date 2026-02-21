import * as S from '@effect/schema/Schema'
import * as Either from 'effect/Either'

type BooleanFlagRequest = {
  key: string
  defaultValue: boolean
}

type BooleanFeatureToggleRequest = {
  fallbackEnvVar?: string
  key: string
  keyEnvVar?: string
  defaultValue: boolean
}

const DEFAULT_TIMEOUT_MS = 500
const DEFAULT_NAMESPACE_KEY = 'default'
const DEFAULT_ENTITY_ID = 'jangar'

const BooleanEvaluationResponseSchema = S.Struct({
  enabled: S.Boolean,
})

const TRUE_BOOLEAN_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const FALSE_BOOLEAN_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled'])

const readNonEmptyEnv = (value: string | undefined) => {
  if (!value) return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = readNonEmptyEnv(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = readNonEmptyEnv(value)?.toLowerCase()
  if (!normalized) return fallback
  if (TRUE_BOOLEAN_VALUES.has(normalized)) return true
  if (FALSE_BOOLEAN_VALUES.has(normalized)) return false
  return fallback
}

const resolveFeatureFlagsEndpoint = () => {
  const value = readNonEmptyEnv(process.env.JANGAR_FEATURE_FLAGS_URL)
  if (!value) return null
  return value.replace(/\/+$/, '')
}

const resolveTimeoutMs = () => parsePositiveInt(process.env.JANGAR_FEATURE_FLAGS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)

const isFeatureFlagsClientEnabled = () => parseBoolean(process.env.JANGAR_FEATURE_FLAGS_ENABLED, true)

const resolveNamespaceKey = () => {
  const value = readNonEmptyEnv(process.env.JANGAR_FEATURE_FLAGS_NAMESPACE)
  return value || DEFAULT_NAMESPACE_KEY
}

const resolveEntityId = () => {
  const value = readNonEmptyEnv(process.env.JANGAR_FEATURE_FLAGS_ENTITY_ID)
  return value || DEFAULT_ENTITY_ID
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

  if (!isFeatureFlagsClientEnabled()) return request.defaultValue

  const endpoint = resolveFeatureFlagsEndpoint()
  if (!endpoint) return request.defaultValue

  const controller = new AbortController()
  const timeoutMs = resolveTimeoutMs()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${endpoint}/evaluate/v1/boolean`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        namespaceKey: resolveNamespaceKey(),
        flagKey: key,
        entityId: resolveEntityId(),
        context: {},
      }),
      signal: controller.signal,
    })

    if (!response.ok) return request.defaultValue

    const body = await response.json()
    const decoded = S.decodeUnknownEither(BooleanEvaluationResponseSchema)(body)
    if (Either.isLeft(decoded)) return request.defaultValue
    return decoded.right.enabled
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
