const ROUTE_PROBE_TIMEOUT_MS = 2_000
const DEFAULT_APP_NAMESPACE = 'jangar'

export type FailureDomainRouteProbe = {
  status: 'healthy' | 'degraded' | 'unknown'
  reachable: boolean
  url: string | null
  status_code: number | null
  latency_ms: number
  message: string
  observed_at: string
}

export type FailureDomainRouteProbeInput = {
  now: Date
  namespace: string
  service: string
  env?: Record<string, string | undefined>
}

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const normalizeErrorMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const resolveRouteProbeUrl = ({ namespace, service, env = process.env }: FailureDomainRouteProbeInput) => {
  const explicitUrl = normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_ROUTE_HEALTH_URL)
  if (explicitUrl) return explicitUrl

  const defaultProbeEnabled = parseBoolean(env.JANGAR_CONTROL_PLANE_ROUTE_PROBE_ENABLED, false)
  if (!defaultProbeEnabled) return null

  const routeNamespace =
    normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_ROUTE_NAMESPACE) ??
    normalizeNonEmpty(env.JANGAR_POD_NAMESPACE) ??
    DEFAULT_APP_NAMESPACE
  const routeService = normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_ROUTE_SERVICE) ?? service
  const routePath = normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_ROUTE_HEALTH_PATH) ?? '/health'
  return `http://${routeService}.${routeNamespace || namespace}.svc.cluster.local${routePath.startsWith('/') ? routePath : `/${routePath}`}`
}

export const resolveFailureDomainRouteProbe = async (
  input: FailureDomainRouteProbeInput,
): Promise<FailureDomainRouteProbe> => {
  const observedAt = input.now.toISOString()
  const url = resolveRouteProbeUrl(input)
  if (!url) {
    return {
      status: 'healthy',
      reachable: true,
      url: null,
      status_code: null,
      latency_ms: 0,
      message: 'status route generated a response; external route probe is not configured',
      observed_at: observedAt,
    }
  }

  const timeoutMs = parsePositiveInt(input.env?.JANGAR_CONTROL_PLANE_ROUTE_PROBE_TIMEOUT_MS, ROUTE_PROBE_TIMEOUT_MS)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const start = Date.now()

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    return {
      status: response.ok ? 'healthy' : 'degraded',
      reachable: response.ok,
      url,
      status_code: response.status,
      latency_ms: Math.max(0, Date.now() - start),
      message: response.ok ? 'route probe succeeded' : `route probe returned HTTP ${response.status}`,
      observed_at: observedAt,
    }
  } catch (error) {
    return {
      status: 'degraded',
      reachable: false,
      url,
      status_code: null,
      latency_ms: Math.max(0, Date.now() - start),
      message: normalizeErrorMessage(error),
      observed_at: observedAt,
    }
  } finally {
    clearTimeout(timeout)
  }
}
