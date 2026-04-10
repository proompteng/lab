import { DiagConsoleLogger, DiagLogLevel, diag } from '@proompteng/otel/api'

type EnvSource = Record<string, string | undefined>

export type OtlpProtocol = 'http/json' | 'http/protobuf' | 'grpc'

export type MetricsConfig = {
  disabledForTest: boolean
  enabled: boolean
  otlpEnabled: boolean
  prometheusEnabled: boolean
  prometheusPath: string
  metricsProtocol: OtlpProtocol
  metricsEndpoint: string | null
  serviceName: string
  serviceNamespace: string
  serviceInstanceId: string
  exportIntervalMillis: number
  headers?: Record<string, string>
  timeoutMillis?: number
}

const DEFAULT_METRICS_ENDPOINT = 'http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics'

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)

const resolveOtlpProtocol = (value: string | undefined): OtlpProtocol => {
  if (!value) return 'http/json'
  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case 'http/protobuf':
    case 'http/proto':
    case 'protobuf':
    case 'proto':
    case 'http':
      return 'http/protobuf'
    case 'http/json':
    case 'json':
      return 'http/json'
    case 'grpc':
      return 'grpc'
    default:
      diag.warn(
        `Unknown OTLP protocol '${value}', expected grpc, http/protobuf, or http/json. Falling back to http/json.`,
      )
      return 'http/json'
  }
}

const stripEndpointPath = (value: string): string => {
  try {
    const url = new URL(value)
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return value.replace(/\/+$/, '')
  }
}

const resolveMetricsEndpoint = (env: EnvSource, protocol: OtlpProtocol): string | null => {
  const explicit = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim()
  if (explicit) return protocol === 'grpc' ? stripEndpointPath(explicit) : explicit
  const lgtm = env.LGTM_MIMIR_METRICS_ENDPOINT?.trim()
  if (lgtm) return protocol === 'grpc' ? stripEndpointPath(lgtm) : lgtm
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (base) {
    if (protocol === 'grpc') {
      return stripEndpointPath(base)
    }
    if (base.endsWith('/v1/metrics')) return base
    const trimmed = base.replace(/\/+$/, '')
    return `${trimmed}/v1/metrics`
  }
  return protocol === 'grpc' ? stripEndpointPath(DEFAULT_METRICS_ENDPOINT) : DEFAULT_METRICS_ENDPOINT
}

const parseHeaders = (value?: string) => {
  if (!value) return undefined
  const result: Record<string, string> = {}
  for (const pair of value.split(',')) {
    const [rawKey, ...rawRest] = pair.split('=')
    if (!rawKey || rawRest.length === 0) continue
    const key = rawKey.trim()
    const rawValue = rawRest.join('=').trim()
    if (!key || !rawValue) continue
    result[key] = rawValue
  }
  return Object.keys(result).length > 0 ? result : undefined
}

const mergeHeaders = (...headers: Array<Record<string, string> | undefined>): Record<string, string> | undefined => {
  const merged: Record<string, string> = {}
  for (const header of headers) {
    if (!header) continue
    Object.assign(merged, header)
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

const parseTimeoutMillis = (value?: string) => {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

const resolveBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const normalizePrometheusPath = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return '/metrics'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

const isMetricsTestEnvironment = (env: EnvSource) => env.NODE_ENV === 'test' || Boolean(env.VITEST)

export const resolveMetricsConfig = (
  env: EnvSource = process.env,
  options?: {
    processId?: number
  },
): MetricsConfig => {
  if (isMetricsTestEnvironment(env)) {
    return {
      disabledForTest: true,
      enabled: false,
      otlpEnabled: false,
      prometheusEnabled: false,
      prometheusPath: '/metrics',
      metricsProtocol: 'http/json',
      metricsEndpoint: null,
      serviceName: env.OTEL_SERVICE_NAME ?? 'jangar',
      serviceNamespace: env.OTEL_SERVICE_NAMESPACE ?? env.POD_NAMESPACE ?? env.KUBERNETES_NAMESPACE ?? 'default',
      serviceInstanceId:
        env.OTEL_SERVICE_INSTANCE_ID ?? env.POD_NAME ?? env.HOSTNAME ?? String(options?.processId ?? process.pid),
      exportIntervalMillis: 15000,
    }
  }

  const prometheusEnabled = resolveBoolean(env.JANGAR_PROMETHEUS_METRICS_ENABLED, true)
  const prometheusPath = normalizePrometheusPath(env.JANGAR_PROMETHEUS_METRICS_PATH ?? '/metrics')
  const exporter = (env.OTEL_METRICS_EXPORTER ?? '').trim().toLowerCase()
  let otlpEnabled = !(exporter === 'none' || exporter === 'false' || exporter === '0')
  let metricsProtocol: OtlpProtocol = 'http/json'
  let metricsEndpoint: string | null = null
  if (otlpEnabled) {
    metricsProtocol = resolveOtlpProtocol(env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL)
    metricsEndpoint = resolveMetricsEndpoint(env, metricsProtocol)
    if (!metricsEndpoint) {
      otlpEnabled = false
    }
  }

  const exportInterval = Number.parseInt(env.OTEL_METRIC_EXPORT_INTERVAL ?? '15000', 10)
  const exportIntervalMillis = Number.isFinite(exportInterval) ? Math.max(exportInterval, 5000) : 15000
  const sharedHeaders = parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)
  const metricHeaders = mergeHeaders(sharedHeaders, parseHeaders(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS))
  const timeoutMillis =
    parseTimeoutMillis(env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT) ?? parseTimeoutMillis(env.OTEL_EXPORTER_OTLP_TIMEOUT)

  return {
    disabledForTest: false,
    enabled: otlpEnabled || prometheusEnabled,
    otlpEnabled,
    prometheusEnabled,
    prometheusPath,
    metricsProtocol,
    metricsEndpoint,
    serviceName: env.OTEL_SERVICE_NAME ?? 'jangar',
    serviceNamespace: env.OTEL_SERVICE_NAMESPACE ?? env.POD_NAMESPACE ?? env.KUBERNETES_NAMESPACE ?? 'default',
    serviceInstanceId:
      env.OTEL_SERVICE_INSTANCE_ID ?? env.POD_NAME ?? env.HOSTNAME ?? String(options?.processId ?? process.pid),
    exportIntervalMillis,
    headers: metricHeaders,
    timeoutMillis,
  }
}

export const __private = {
  mergeHeaders,
  normalizePrometheusPath,
  parseHeaders,
  parseTimeoutMillis,
  resolveBoolean,
  resolveMetricsEndpoint,
  resolveOtlpProtocol,
}
