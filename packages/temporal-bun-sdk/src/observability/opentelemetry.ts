import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Resource } from '@opentelemetry/resources'
import { type MetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'

export interface OpenTelemetryConfig {
  enabled?: boolean
  serviceName?: string
  serviceNamespace?: string
  serviceInstanceId?: string
  tracesEndpoint?: string
  metricsEndpoint?: string
  exportIntervalMs?: number
  headers?: Record<string, string>
  traceHeaders?: Record<string, string>
  metricHeaders?: Record<string, string>
}

export interface OpenTelemetryHandle {
  shutdown: () => Promise<void>
}

const DEFAULT_TRACES_ENDPOINT = 'http://localhost:4318/v1/traces'
const DEFAULT_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics'

let activeHandle: OpenTelemetryHandle | undefined
let starting: Promise<OpenTelemetryHandle | undefined> | undefined

export const registerOpenTelemetry = async (
  options: OpenTelemetryConfig = {},
): Promise<OpenTelemetryHandle | undefined> => {
  if (activeHandle) {
    return activeHandle
  }
  if (starting) {
    return starting
  }
  starting = startOpenTelemetry(options)
  const resolved = await starting
  starting = undefined
  if (resolved) {
    activeHandle = resolved
  }
  return resolved
}

const startOpenTelemetry = async (options: OpenTelemetryConfig): Promise<OpenTelemetryHandle | undefined> => {
  if (!shouldEnableOpenTelemetry(options)) {
    return undefined
  }

  diag.setLogger(new DiagConsoleLogger(), resolveDiagLogLevel())

  const serviceName =
    options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? process.env.LGTM_SERVICE_NAME ?? 'temporal-bun-worker'
  const serviceNamespace = options.serviceNamespace ?? process.env.OTEL_SERVICE_NAMESPACE ?? process.env.POD_NAMESPACE
  const serviceInstanceId =
    options.serviceInstanceId ?? process.env.OTEL_SERVICE_INSTANCE_ID ?? process.env.POD_NAME ?? process.pid.toString()

  const tracesEndpoint =
    options.tracesEndpoint ??
    process.env.LGTM_TEMPO_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    resolveEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'traces') ??
    DEFAULT_TRACES_ENDPOINT
  const metricsEndpoint =
    options.metricsEndpoint ??
    process.env.LGTM_MIMIR_METRICS_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    resolveEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'metrics') ??
    DEFAULT_METRICS_ENDPOINT

  const exportInterval = options.exportIntervalMs ?? parseNumber(process.env.OTEL_METRIC_EXPORT_INTERVAL) ?? 15000

  const sharedHeaders = mergeHeaders(parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS), options.headers)
  const traceHeaders = mergeHeaders(
    sharedHeaders,
    parseHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    options.traceHeaders,
  )
  const metricHeaders = mergeHeaders(
    sharedHeaders,
    parseHeaders(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS),
    options.metricHeaders,
  )

  const resourceAttributes = parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES)
  const resource = Resource.default()
    .merge(new Resource(resourceAttributes))
    .merge(
      new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        ...(serviceNamespace ? { [SemanticResourceAttributes.SERVICE_NAMESPACE]: serviceNamespace } : {}),
        ...(serviceInstanceId ? { [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: serviceInstanceId } : {}),
      }),
    )

  const metricReader: MetricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: metricsEndpoint,
      headers: metricHeaders,
    }),
    exportIntervalMillis: Number.isFinite(exportInterval) ? Math.max(exportInterval, 5000) : 15000,
  })

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: tracesEndpoint,
      headers: traceHeaders,
    }),
    metricReader,
    instrumentations: resolveInstrumentations(),
  })

  try {
    await sdk.start()
  } catch (error) {
    diag.error('failed to start OpenTelemetry SDK', error)
    return undefined
  }

  const handle: OpenTelemetryHandle = {
    shutdown: async () => {
      try {
        await sdk.shutdown()
      } catch (error) {
        diag.error('failed to gracefully shutdown OpenTelemetry SDK', error)
      }
    },
  }

  const shutdownOnce = () => {
    void handle.shutdown()
  }
  process.once('SIGTERM', shutdownOnce)
  process.once('SIGINT', shutdownOnce)

  return handle
}

const shouldEnableOpenTelemetry = (options: OpenTelemetryConfig): boolean => {
  if (coerceBoolean(process.env.OTEL_SDK_DISABLED)) {
    return false
  }
  if (options.enabled !== undefined) {
    return options.enabled
  }
  const envEnabled = coerceBoolean(process.env.TEMPORAL_OTEL_ENABLED)
  if (envEnabled !== undefined) {
    return envEnabled
  }
  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_SERVICE_NAME ||
      process.env.LGTM_TEMPO_TRACES_ENDPOINT ||
      process.env.LGTM_MIMIR_METRICS_ENDPOINT,
  )
}

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

const coerceBoolean = (value: string | undefined): boolean | undefined => {
  if (!value) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) {
    return false
  }
  return undefined
}

const resolveInstrumentations = () => {
  const enabled = coerceBoolean(process.env.TEMPORAL_OTEL_AUTO_INSTRUMENTATION)
  if (enabled === false) {
    return []
  }
  if (enabled === undefined) {
    return []
  }
  return [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-undici': {
        enabled: true,
      },
    }),
  ]
}

const resolveEndpoint = (endpoint: string | undefined, signal: 'traces' | 'metrics'): string | undefined => {
  if (!endpoint) {
    return undefined
  }
  const trimmed = endpoint.trim()
  if (!trimmed) {
    return undefined
  }
  const base = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  return `${base}/v1/${signal}`
}

const resolveDiagLogLevel = (): DiagLogLevel => {
  const raw = process.env.OTEL_LOG_LEVEL ?? process.env.TEMPORAL_OTEL_LOG_LEVEL
  if (!raw) {
    return DiagLogLevel.ERROR
  }
  switch (raw.trim().toLowerCase()) {
    case 'none':
      return DiagLogLevel.NONE
    case 'debug':
      return DiagLogLevel.DEBUG
    case 'info':
      return DiagLogLevel.INFO
    case 'warn':
      return DiagLogLevel.WARN
    case 'error':
      return DiagLogLevel.ERROR
    default:
      return DiagLogLevel.ERROR
  }
}

function parseHeaders(value?: string) {
  if (!value) {
    return undefined
  }

  const result: Record<string, string> = {}

  for (const pair of value.split(',')) {
    const [rawKey, ...rawRest] = pair.split('=')
    if (!rawKey || rawRest.length === 0) {
      continue
    }
    const key = rawKey.trim()
    const rawValue = rawRest.join('=').trim()
    if (!key || !rawValue) {
      continue
    }
    result[key] = rawValue
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function mergeHeaders(...headers: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
  const merged: Record<string, string> = {}

  for (const header of headers) {
    if (!header) {
      continue
    }
    Object.assign(merged, header)
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

function parseResourceAttributes(value?: string): Record<string, string> {
  if (!value) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const pair of value.split(',')) {
    const [rawKey, ...rawRest] = pair.split('=')
    if (!rawKey || rawRest.length === 0) {
      continue
    }
    const key = rawKey.trim()
    const rawValue = rawRest.join('=').trim()
    if (!key || !rawValue) {
      continue
    }
    result[key] = rawValue
  }
  return result
}
