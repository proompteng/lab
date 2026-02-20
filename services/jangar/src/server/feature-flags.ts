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

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const resolveFlagdEndpoint = () => {
  const value = process.env.JANGAR_FEATURE_FLAGS_URL?.trim()
  if (!value) return null
  return value.replace(/\/+$/, '')
}

const resolveTimeoutMs = () => parsePositiveInt(process.env.JANGAR_FEATURE_FLAGS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)

const isFeatureFlagsClientEnabled = () => parseBoolean(process.env.JANGAR_FEATURE_FLAGS_ENABLED, true)

const resolveBooleanFallback = (request: BooleanFeatureToggleRequest) => {
  if (!request.fallbackEnvVar) return request.defaultValue
  return parseBoolean(process.env[request.fallbackEnvVar], request.defaultValue)
}

const resolveFlagKey = (request: BooleanFeatureToggleRequest) => {
  const fromEnv = request.keyEnvVar ? process.env[request.keyEnvVar]?.trim() : ''
  return fromEnv || request.key
}

export const getBooleanFeatureFlag = async (request: BooleanFlagRequest): Promise<boolean> => {
  const key = request.key.trim()
  if (!key) return request.defaultValue

  if (!isFeatureFlagsClientEnabled()) return request.defaultValue

  const endpoint = resolveFlagdEndpoint()
  if (!endpoint) return request.defaultValue

  const controller = new AbortController()
  const timeoutMs = resolveTimeoutMs()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${endpoint}/schema.v1.Service/ResolveBoolean`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        flagKey: key,
      }),
      signal: controller.signal,
    })

    if (!response.ok) return request.defaultValue

    const body = (await response.json()) as { value?: unknown }
    return typeof body.value === 'boolean' ? body.value : request.defaultValue
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
