import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'
import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node'

export interface OpenTelemetryConfig {
  enabled?: boolean
  serviceName?: string
  serviceNamespace?: string
  serviceInstanceId?: string
  tracesEndpoint?: string
  metricsEndpoint?: string
  exportIntervalMs?: number
  metricExportTimeoutMs?: number
  traceTimeoutMs?: number
  metricTimeoutMs?: number
  headers?: Record<string, string>
  traceHeaders?: Record<string, string>
  metricHeaders?: Record<string, string>
}

export interface OpenTelemetryHandle {
  shutdown: () => Promise<void>
}

const DEFAULT_TRACES_ENDPOINT = 'http://localhost:4318/v1/traces'
const DEFAULT_METRICS_ENDPOINT = 'http://localhost:4318/v1/metrics'
const DEFAULT_OTLP_PROTOCOL: OtlpProtocol = 'http/json'

type OtlpProtocol = 'http/json' | 'http/protobuf'

type OpenTelemetryCoreModules = {
  api: typeof import('@opentelemetry/api')
  autoInstrumentations: typeof import('@opentelemetry/auto-instrumentations-node')
  resources: typeof import('@opentelemetry/resources')
  sdkMetrics: typeof import('@opentelemetry/sdk-metrics')
  sdkNode: typeof import('@opentelemetry/sdk-node')
  semantic: typeof import('@opentelemetry/semantic-conventions')
}

const applyBunNodeVersionShim = (): void => {
  const versions = typeof process !== 'undefined' ? (process.versions as Record<string, string>) : undefined
  const bunVersion = versions?.bun
  const nodeVersion = versions?.node
  if (!bunVersion || !nodeVersion) {
    return
  }
  const [major] = nodeVersion.split('.')
  const needsShim = Number.parseInt(major ?? '', 10) >= 14
  if (!needsShim) {
    return
  }
  versions.node = '12.0.0'
}

const loadOpenTelemetryCoreModules = async (): Promise<OpenTelemetryCoreModules> => {
  const [api, autoInstrumentations, resources, sdkMetrics, sdkNode, semantic] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/semantic-conventions'),
  ])

  return {
    api,
    autoInstrumentations,
    resources,
    sdkMetrics,
    sdkNode,
    semantic,
  }
}

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

  applyBunNodeVersionShim()
  const otel = await loadOpenTelemetryCoreModules()
  const { diag, DiagConsoleLogger, DiagLogLevel } = otel.api

  diag.setLogger(new DiagConsoleLogger(), resolveDiagLogLevel(DiagLogLevel))

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

  const metricsEnabled = shouldEnableMetrics(metricsEndpoint)
  const exportInterval = options.exportIntervalMs ?? parseNumber(process.env.OTEL_METRIC_EXPORT_INTERVAL) ?? 15000
  const tracesProtocol = resolveOtlpProtocol(
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
    diag,
  )
  const metricsProtocol = resolveOtlpProtocol(
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
    diag,
  )
  const tracesTimeoutMs = resolveTimeoutMs(
    options.traceTimeoutMs,
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT,
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT,
  )
  const metricsTimeoutMs = resolveTimeoutMs(
    options.metricTimeoutMs,
    process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT,
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT,
  )
  const metricExportTimeoutMs = resolveTimeoutMs(
    options.metricExportTimeoutMs,
    process.env.OTEL_METRIC_EXPORT_TIMEOUT,
    metricsTimeoutMs ? String(metricsTimeoutMs) : undefined,
  )
  let exportIntervalMillis = Number.isFinite(exportInterval) ? Math.max(exportInterval, 5000) : 15000
  const exportTimeoutMillis = metricExportTimeoutMs ? Math.max(metricExportTimeoutMs, 5000) : undefined
  if (exportTimeoutMillis && exportTimeoutMillis > exportIntervalMillis) {
    exportIntervalMillis = exportTimeoutMillis
  }

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
  const resource = otel.resources.Resource.default()
    .merge(new otel.resources.Resource(resourceAttributes))
    .merge(
      new otel.resources.Resource({
        [otel.semantic.SEMRESATTRS_SERVICE_NAME]: serviceName,
        ...(serviceNamespace ? { [otel.semantic.SEMRESATTRS_SERVICE_NAMESPACE]: serviceNamespace } : {}),
        ...(serviceInstanceId ? { [otel.semantic.SEMRESATTRS_SERVICE_INSTANCE_ID]: serviceInstanceId } : {}),
      }),
    )

  const traceExporter = await loadTraceExporter(tracesProtocol, {
    url: tracesEndpoint,
    headers: traceHeaders,
    ...(tracesTimeoutMs ? { timeoutMillis: tracesTimeoutMs } : {}),
  })

  let metricReader: InstanceType<typeof otel.sdkMetrics.PeriodicExportingMetricReader> | undefined
  if (metricsEnabled) {
    const metricExporter = await loadMetricExporter(metricsProtocol, {
      url: metricsEndpoint,
      headers: metricHeaders,
      ...(metricsTimeoutMs ? { timeoutMillis: metricsTimeoutMs } : {}),
    })
    metricReader = new otel.sdkMetrics.PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis,
      ...(exportTimeoutMillis ? { exportTimeoutMillis } : {}),
    })
  }

  const sdkConfig: Partial<NodeSDKConfiguration> = {
    resource,
    traceExporter,
    instrumentations: resolveInstrumentations(otel.autoInstrumentations.getNodeAutoInstrumentations),
  }
  if (metricReader) {
    sdkConfig.metricReader = metricReader
  }

  const sdk = new otel.sdkNode.NodeSDK(sdkConfig)

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

const shouldEnableMetrics = (metricsEndpoint: string | undefined): boolean => {
  const exporter = process.env.OTEL_METRICS_EXPORTER?.trim().toLowerCase()
  if (exporter === 'none' || exporter === 'false') {
    return false
  }
  if (exporter && exporter !== 'otlp') {
    return true
  }
  return Boolean(metricsEndpoint)
}

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

const resolveTimeoutMs = (
  explicit: number | undefined,
  signalValue: string | undefined,
  fallbackValue?: string | undefined,
): number | undefined => {
  const parsed = explicit ?? parseNumber(signalValue) ?? parseNumber(fallbackValue)
  if (parsed === undefined) {
    return undefined
  }
  return Math.max(parsed, 1000)
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

const resolveInstrumentations = (
  getNodeAutoInstrumentations: typeof import('@opentelemetry/auto-instrumentations-node').getNodeAutoInstrumentations,
) => {
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

const resolveDiagLogLevel = (DiagLogLevel: typeof import('@opentelemetry/api').DiagLogLevel) => {
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

const resolveOtlpProtocol = (value: string | undefined, logger: Pick<Console, 'warn'> = console): OtlpProtocol => {
  if (!value) {
    return DEFAULT_OTLP_PROTOCOL
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
      logger.warn(
        `Unknown OTLP protocol '${value}', expected http/protobuf or http/json. Falling back to ${DEFAULT_OTLP_PROTOCOL}.`,
      )
      return DEFAULT_OTLP_PROTOCOL
  }
}

type ExporterConfig = { url: string; headers?: Record<string, string>; timeoutMillis?: number }
type MetricExporterModule = { OTLPMetricExporter: new (config: ExporterConfig) => PushMetricExporter }
type TraceExporter = NonNullable<NodeSDKConfiguration['traceExporter']>
type TraceExporterModule = { OTLPTraceExporter: new (config: ExporterConfig) => TraceExporter }

const loadMetricExporter = async (protocol: OtlpProtocol, config: ExporterConfig): Promise<PushMetricExporter> => {
  const moduleId =
    protocol === 'http/protobuf'
      ? '@opentelemetry/exporter-metrics-otlp-proto'
      : '@opentelemetry/exporter-metrics-otlp-http'
  const module = (await import(moduleId)) as MetricExporterModule
  return new module.OTLPMetricExporter(config)
}

const loadTraceExporter = async (protocol: OtlpProtocol, config: ExporterConfig): Promise<TraceExporter> => {
  const moduleId =
    protocol === 'http/protobuf'
      ? '@opentelemetry/exporter-trace-otlp-proto'
      : '@opentelemetry/exporter-trace-otlp-http'
  const module = (await import(moduleId)) as TraceExporterModule
  return new module.OTLPTraceExporter(config)
}
