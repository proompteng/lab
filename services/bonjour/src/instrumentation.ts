import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPMetricExporter as OTLPMetricExporterHttp } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPMetricExporter as OTLPMetricExporterProto } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPTraceExporter as OTLPTraceExporterProto } from '@opentelemetry/exporter-trace-otlp-proto'
import { Resource } from '@opentelemetry/resources'
import { type MetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  SEMRESATTRS_SERVICE_INSTANCE_ID,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
} from '@opentelemetry/semantic-conventions'

diag.setLogger(new DiagConsoleLogger(), resolveDiagLogLevel(DiagLogLevel))

if (!isTruthy(process.env.OTEL_SDK_DISABLED)) {
  applyBunNodeVersionShim()

  const serviceName = process.env.OTEL_SERVICE_NAME ?? process.env.LGTM_SERVICE_NAME ?? 'bonjour'
  const serviceNamespace = process.env.OTEL_SERVICE_NAMESPACE ?? process.env.POD_NAMESPACE ?? 'default'
  const serviceInstanceId = process.env.OTEL_SERVICE_INSTANCE_ID ?? process.env.POD_NAME ?? process.pid.toString()

  const tracesEndpoint =
    process.env.LGTM_TEMPO_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    resolveEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'traces') ??
    'http://observability-tempo-gateway.observability.svc.cluster.local:4318/v1/traces'
  const metricsEndpoint =
    process.env.LGTM_MIMIR_METRICS_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    resolveEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'metrics') ??
    'http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics'

  const tracesProtocol = resolveOtlpProtocol(
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
    diag,
  )
  const metricsProtocol = resolveOtlpProtocol(
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
    diag,
  )

  const tracesTimeoutMs = resolveTimeoutMs(
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT,
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT,
  )
  const metricsTimeoutMs = resolveTimeoutMs(
    process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT,
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT,
  )

  const exportInterval = parseNumber(process.env.OTEL_METRIC_EXPORT_INTERVAL) ?? 15000
  const exportTimeout = resolveTimeoutMs(
    process.env.OTEL_METRIC_EXPORT_TIMEOUT,
    metricsTimeoutMs ? String(metricsTimeoutMs) : undefined,
  )

  let exportIntervalMillis = Number.isFinite(exportInterval) ? Math.max(exportInterval, 5000) : 15000
  const exportTimeoutMillis = exportTimeout ? Math.max(exportTimeout, 5000) : undefined
  if (exportTimeoutMillis && exportTimeoutMillis > exportIntervalMillis) {
    exportIntervalMillis = exportTimeoutMillis
  }

  const sharedHeaders = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const traceHeaders = mergeHeaders(sharedHeaders, parseHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS))
  const metricHeaders = mergeHeaders(sharedHeaders, parseHeaders(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS))

  const resourceAttributes = parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES)
  const resource = Resource.default()
    .merge(new Resource(resourceAttributes))
    .merge(
      new Resource({
        [SEMRESATTRS_SERVICE_NAME]: serviceName,
        [SEMRESATTRS_SERVICE_NAMESPACE]: serviceNamespace,
        [SEMRESATTRS_SERVICE_INSTANCE_ID]: serviceInstanceId,
      }),
    )

  const traceExporter = createTraceExporter(tracesProtocol, {
    url: tracesEndpoint,
    headers: traceHeaders,
    ...(tracesTimeoutMs ? { timeoutMillis: tracesTimeoutMs } : {}),
  })

  let metricReader: MetricReader | undefined
  if (shouldEnableMetrics(metricsEndpoint)) {
    const metricExporter = createMetricExporter(metricsProtocol, {
      url: metricsEndpoint,
      headers: metricHeaders,
      ...(metricsTimeoutMs ? { timeoutMillis: metricsTimeoutMs } : {}),
    })

    metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis,
      ...(exportTimeoutMillis ? { exportTimeoutMillis } : {}),
    })
  }

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    ...(metricReader ? { metricReader } : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-undici': {
          enabled: true,
        },
      }),
    ],
  })

  let shuttingDown = false

  try {
    Promise.resolve(sdk.start()).catch((error) => {
      diag.error('failed to start OpenTelemetry SDK', error)
    })
  } catch (error) {
    diag.error('failed to start OpenTelemetry SDK', error)
  }

  const shutdown = () => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    void sdk.shutdown().catch((error) => {
      diag.error('failed to gracefully shutdown OpenTelemetry SDK', error)
    })
  }

  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
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

function isTruthy(value?: string) {
  if (!value) {
    return false
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function parseNumber(value?: string): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function resolveTimeoutMs(signalValue?: string, fallbackValue?: string): number | undefined {
  const parsed = parseNumber(signalValue) ?? parseNumber(fallbackValue)
  if (parsed === undefined) {
    return undefined
  }
  return Math.max(parsed, 1000)
}

function resolveEndpoint(endpoint: string | undefined, signal: 'traces' | 'metrics'): string | undefined {
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

function shouldEnableMetrics(metricsEndpoint: string | undefined): boolean {
  const exporter = process.env.OTEL_METRICS_EXPORTER?.trim().toLowerCase()
  if (exporter === 'none' || exporter === 'false') {
    return false
  }
  if (exporter && exporter !== 'otlp') {
    return true
  }
  return Boolean(metricsEndpoint)
}

function resolveDiagLogLevel(DiagLogLevel: typeof import('@opentelemetry/api').DiagLogLevel) {
  const raw = process.env.OTEL_LOG_LEVEL
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

type OtlpProtocol = 'http/json' | 'http/protobuf'

function resolveOtlpProtocol(value: string | undefined, logger: Pick<Console, 'warn'> = console): OtlpProtocol {
  if (!value) {
    return 'http/json'
  }
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
      logger.warn(
        'OTLP gRPC protocol requested, falling back to http/protobuf (grpc is not supported in this runtime).',
      )
      return 'http/protobuf'
    default:
      logger.warn(`Unknown OTLP protocol '${value}', expected http/protobuf or http/json. Falling back to http/json.`)
      return 'http/json'
  }
}

type ExporterConfig = { url: string; headers?: Record<string, string>; timeoutMillis?: number }

function createTraceExporter(protocol: OtlpProtocol, config: ExporterConfig) {
  if (protocol === 'http/protobuf') {
    return new OTLPTraceExporterProto(config)
  }
  return new OTLPTraceExporterHttp(config)
}

function createMetricExporter(protocol: OtlpProtocol, config: ExporterConfig) {
  if (protocol === 'http/protobuf') {
    return new OTLPMetricExporterProto(config)
  }
  return new OTLPMetricExporterHttp(config)
}

function applyBunNodeVersionShim() {
  const versions = process.versions as Record<string, string | undefined>
  const bunVersion = versions.bun
  const nodeVersion = versions.node
  if (!bunVersion || !nodeVersion) {
    return
  }
  const [major] = nodeVersion.split('.')
  if (Number.parseInt(major ?? '', 10) < 14) {
    return
  }
  versions.node = '12.0.0'
}
