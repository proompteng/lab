import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { z } from 'zod'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 7233
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_TASK_QUEUE = 'prix'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-worker'

const envSchema = z.object({
  TEMPORAL_ADDRESS: z.string().trim().min(1).optional(),
  TEMPORAL_HOST: z.string().trim().min(1).optional(),
  TEMPORAL_GRPC_PORT: z.string().trim().regex(/^\d+$/, 'TEMPORAL_GRPC_PORT must be a positive integer').optional(),
  TEMPORAL_NAMESPACE: z.string().trim().min(1).default(DEFAULT_NAMESPACE),
  TEMPORAL_TASK_QUEUE: z.string().trim().min(1).default(DEFAULT_TASK_QUEUE),
  TEMPORAL_API_KEY: z.string().trim().optional(),
  TEMPORAL_TLS_CA_PATH: z.string().trim().min(1).optional(),
  TEMPORAL_TLS_CERT_PATH: z.string().trim().min(1).optional(),
  TEMPORAL_TLS_KEY_PATH: z.string().trim().min(1).optional(),
  TEMPORAL_TLS_SERVER_NAME: z.string().trim().min(1).optional(),
  TEMPORAL_ALLOW_INSECURE: z.string().trim().optional(),
  ALLOW_INSECURE_TLS: z.string().trim().optional(),
  TEMPORAL_WORKER_IDENTITY_PREFIX: z.string().trim().min(1).optional(),
  TEMPORAL_SHOW_STACK_SOURCES: z.string().trim().optional(),
  TEMPORAL_LOG_FILTER: z.string().trim().optional(),
  TEMPORAL_METRICS_PREFIX: z.string().trim().optional(),
  TEMPORAL_METRICS_ATTACH_SERVICE_NAME: z.string().trim().optional(),
  TEMPORAL_METRICS_EXPORTER: z.string().trim().optional(),
  TEMPORAL_PROMETHEUS_ENDPOINT: z.string().trim().optional(),
  TEMPORAL_PROMETHEUS_COUNTERS_TOTAL_SUFFIX: z.string().trim().optional(),
  TEMPORAL_PROMETHEUS_UNIT_SUFFIX: z.string().trim().optional(),
  TEMPORAL_PROMETHEUS_USE_SECONDS: z.string().trim().optional(),
  TEMPORAL_METRICS_GLOBAL_TAGS: z.string().trim().optional(),
  TEMPORAL_METRICS_HISTOGRAM_OVERRIDES: z.string().trim().optional(),
  TEMPORAL_OTLP_ENDPOINT: z.string().trim().optional(),
  TEMPORAL_OTLP_PROTOCOL: z.string().trim().optional(),
  TEMPORAL_OTLP_METRIC_TEMPORALITY: z.string().trim().optional(),
})

const truthyValues = new Set(['1', 'true', 't', 'yes', 'y', 'on'])
const falsyValues = new Set(['0', 'false', 'f', 'no', 'n', 'off'])

const coerceBoolean = (raw: string | undefined): boolean | undefined => {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (truthyValues.has(normalized)) return true
  if (falsyValues.has(normalized)) return false
  return undefined
}

const parsePort = (raw: string | undefined): number => {
  if (!raw) return DEFAULT_PORT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid Temporal gRPC port: ${raw}`)
  }
  return parsed
}

const parseJsonRecord = (raw: string | undefined, description: string): Record<string, string> | undefined => {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${description} must be a JSON object: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${description} must be a JSON object mapping keys to string values`)
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) {
      throw new Error(`${description} values must be strings, numbers, or booleans`)
    }
    result[key] = String(value)
  }
  return result
}

const parseHistogramOverrides = (raw: string | undefined): Record<string, number[]> | undefined => {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `TEMPORAL_METRICS_HISTOGRAM_OVERRIDES must be a JSON object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TEMPORAL_METRICS_HISTOGRAM_OVERRIDES must be a JSON object mapping metric names to arrays')
  }
  const result: Record<string, number[]> = {}
  for (const [metric, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`Histogram override for '${metric}' must be a non-empty array of numbers`)
    }
    const buckets = value.map((entry) => {
      if (typeof entry !== 'number' || Number.isNaN(entry)) {
        throw new Error(`Histogram override for '${metric}' must contain only finite numbers`)
      }
      return entry
    })
    result[metric] = buckets
  }
  return result
}

export interface LoadTemporalConfigOptions {
  env?: NodeJS.ProcessEnv
  fs?: {
    readFile?: typeof readFile
  }
  defaults?: Partial<TemporalConfig>
}

export interface TemporalConfig {
  host: string
  port: number
  address: string
  namespace: string
  taskQueue: string
  apiKey?: string
  tls?: TLSConfig
  allowInsecureTls: boolean
  workerIdentity: string
  workerIdentityPrefix: string
  showStackTraceSources?: boolean
  telemetry?: RuntimeTelemetryConfig
}

export interface TLSCertPair {
  crt: Buffer
  key: Buffer
}

export interface TLSConfig {
  serverRootCACertificate?: Buffer
  serverNameOverride?: string
  clientCertPair?: TLSCertPair
}

export type PrometheusMetricsExporterConfig = {
  type: 'prometheus'
  socketAddr: string
  countersTotalSuffix?: boolean
  unitSuffix?: boolean
  useSecondsForDurations?: boolean
  globalTags?: Record<string, string>
  histogramBucketOverrides?: Record<string, number[]>
}

export type OtelMetricsExporterConfig = {
  type: 'otel'
  url: string
  protocol?: 'http' | 'grpc'
  metricPeriodicity?: number
  metricTemporality?: 'cumulative' | 'delta'
  useSecondsForDurations?: boolean
  headers?: Record<string, string>
  globalTags?: Record<string, string>
  histogramBucketOverrides?: Record<string, number[]>
}

export type MetricsExporterConfig = PrometheusMetricsExporterConfig | OtelMetricsExporterConfig

export interface RuntimeTelemetryConfig {
  logFilter?: string
  metricPrefix?: string
  attachServiceName?: boolean
  metricsExporter?: MetricsExporterConfig | null
}

const cloneMetricsExporter = (
  exporter: MetricsExporterConfig | null | undefined,
): MetricsExporterConfig | null | undefined => {
  if (exporter === undefined) return undefined
  if (exporter === null) return null
  if (exporter.type === 'prometheus') {
    return {
      type: 'prometheus',
      socketAddr: exporter.socketAddr,
      countersTotalSuffix: exporter.countersTotalSuffix,
      unitSuffix: exporter.unitSuffix,
      useSecondsForDurations: exporter.useSecondsForDurations,
      globalTags: exporter.globalTags ? { ...exporter.globalTags } : undefined,
      histogramBucketOverrides: exporter.histogramBucketOverrides
        ? Object.fromEntries(
            Object.entries(exporter.histogramBucketOverrides).map(([key, buckets]) => [key, [...buckets]]),
          )
        : undefined,
    }
  }
  return {
    type: 'otel',
    url: exporter.url,
    protocol: exporter.protocol,
    metricPeriodicity: exporter.metricPeriodicity,
    metricTemporality: exporter.metricTemporality,
    useSecondsForDurations: exporter.useSecondsForDurations,
    headers: exporter.headers ? { ...exporter.headers } : undefined,
    globalTags: exporter.globalTags ? { ...exporter.globalTags } : undefined,
    histogramBucketOverrides: exporter.histogramBucketOverrides
      ? Object.fromEntries(
          Object.entries(exporter.histogramBucketOverrides).map(([key, buckets]) => [key, [...buckets]]),
        )
      : undefined,
  }
}

const buildTelemetryConfig = (
  env: z.infer<typeof envSchema>,
  defaults?: Partial<TemporalConfig>,
): RuntimeTelemetryConfig | undefined => {
  const base = defaults?.telemetry
  const telemetry: RuntimeTelemetryConfig = {
    logFilter: base?.logFilter,
    metricPrefix: base?.metricPrefix,
    attachServiceName: base?.attachServiceName,
    metricsExporter: cloneMetricsExporter(base?.metricsExporter),
  }

  let hasValue = Boolean(
    telemetry.logFilter !== undefined ||
      telemetry.metricPrefix !== undefined ||
      telemetry.attachServiceName !== undefined ||
      telemetry.metricsExporter !== undefined,
  )

  if (env.TEMPORAL_LOG_FILTER !== undefined) {
    const filter = env.TEMPORAL_LOG_FILTER.trim()
    telemetry.logFilter = filter.length > 0 ? filter : undefined
    hasValue ||= filter.length > 0
  }

  if (env.TEMPORAL_METRICS_PREFIX !== undefined) {
    const prefix = env.TEMPORAL_METRICS_PREFIX.trim()
    telemetry.metricPrefix = prefix
    hasValue = true
  }

  const attach = coerceBoolean(env.TEMPORAL_METRICS_ATTACH_SERVICE_NAME)
  if (attach !== undefined) {
    telemetry.attachServiceName = attach
    hasValue = true
  }

  const exporterTypeRaw = env.TEMPORAL_METRICS_EXPORTER?.trim().toLowerCase()
  if (exporterTypeRaw) {
    hasValue = true
    if (exporterTypeRaw === 'none' || exporterTypeRaw === 'off' || exporterTypeRaw === 'disabled') {
      telemetry.metricsExporter = null
    } else if (exporterTypeRaw === 'prometheus' || exporterTypeRaw === 'prom') {
      telemetry.metricsExporter = {
        type: 'prometheus',
        socketAddr:
          telemetry.metricsExporter && telemetry.metricsExporter.type === 'prometheus'
            ? telemetry.metricsExporter.socketAddr
            : '',
      }
    } else if (exporterTypeRaw === 'otel' || exporterTypeRaw === 'otlp') {
      telemetry.metricsExporter = {
        type: 'otel',
        url:
          telemetry.metricsExporter && telemetry.metricsExporter.type === 'otel' ? telemetry.metricsExporter.url : '',
        protocol:
          telemetry.metricsExporter && telemetry.metricsExporter.type === 'otel'
            ? telemetry.metricsExporter.protocol
            : undefined,
        metricPeriodicity:
          telemetry.metricsExporter && telemetry.metricsExporter.type === 'otel'
            ? telemetry.metricsExporter.metricPeriodicity
            : undefined,
        metricTemporality:
          telemetry.metricsExporter && telemetry.metricsExporter.type === 'otel'
            ? telemetry.metricsExporter.metricTemporality
            : undefined,
        useSecondsForDurations:
          telemetry.metricsExporter && telemetry.metricsExporter.type === 'otel'
            ? telemetry.metricsExporter.useSecondsForDurations
            : undefined,
        headers:
          telemetry.metricsExporter && telemetry.metricsExporter.type === 'otel'
            ? telemetry.metricsExporter.headers
            : undefined,
        globalTags:
          telemetry.metricsExporter && telemetry.metricsExporter.type === 'otel'
            ? telemetry.metricsExporter.globalTags
            : undefined,
        histogramBucketOverrides:
          telemetry.metricsExporter && telemetry.metricsExporter.type === 'otel'
            ? telemetry.metricsExporter.histogramBucketOverrides
            : undefined,
      }
    } else {
      throw new Error(`Unsupported TEMPORAL_METRICS_EXPORTER value: ${env.TEMPORAL_METRICS_EXPORTER}`)
    }
  }

  const prometheusEndpoint = env.TEMPORAL_PROMETHEUS_ENDPOINT?.trim()
  if (prometheusEndpoint) {
    if (
      !telemetry.metricsExporter ||
      telemetry.metricsExporter === null ||
      telemetry.metricsExporter.type !== 'prometheus'
    ) {
      telemetry.metricsExporter = {
        type: 'prometheus',
        socketAddr: prometheusEndpoint,
      }
    } else {
      telemetry.metricsExporter.socketAddr = prometheusEndpoint
    }
    hasValue = true
  }

  const otlpEndpoint = env.TEMPORAL_OTLP_ENDPOINT?.trim()
  if (otlpEndpoint) {
    if (!telemetry.metricsExporter || telemetry.metricsExporter === null || telemetry.metricsExporter.type !== 'otel') {
      telemetry.metricsExporter = {
        type: 'otel',
        url: otlpEndpoint,
      }
    } else {
      telemetry.metricsExporter.url = otlpEndpoint
    }
    hasValue = true
  }

  const globalTags = parseJsonRecord(env.TEMPORAL_METRICS_GLOBAL_TAGS, 'TEMPORAL_METRICS_GLOBAL_TAGS')
  const histogramOverrides = parseHistogramOverrides(env.TEMPORAL_METRICS_HISTOGRAM_OVERRIDES)

  if (telemetry.metricsExporter && telemetry.metricsExporter.type === 'prometheus') {
    if (!telemetry.metricsExporter.socketAddr) {
      throw new Error(
        'Prometheus metrics exporter requires TEMPORAL_PROMETHEUS_ENDPOINT or defaults.telemetry.metricsExporter.socketAddr',
      )
    }
    const countersSuffix = coerceBoolean(env.TEMPORAL_PROMETHEUS_COUNTERS_TOTAL_SUFFIX)
    if (countersSuffix !== undefined) {
      telemetry.metricsExporter.countersTotalSuffix = countersSuffix
    }
    const unitSuffix = coerceBoolean(env.TEMPORAL_PROMETHEUS_UNIT_SUFFIX)
    if (unitSuffix !== undefined) {
      telemetry.metricsExporter.unitSuffix = unitSuffix
    }
    const useSeconds = coerceBoolean(env.TEMPORAL_PROMETHEUS_USE_SECONDS)
    if (useSeconds !== undefined) {
      telemetry.metricsExporter.useSecondsForDurations = useSeconds
    }
    if (globalTags) {
      telemetry.metricsExporter.globalTags = globalTags
      hasValue = true
    }
    if (histogramOverrides) {
      telemetry.metricsExporter.histogramBucketOverrides = histogramOverrides
      hasValue = true
    }
  } else if (telemetry.metricsExporter && telemetry.metricsExporter.type === 'otel') {
    if (!telemetry.metricsExporter.url) {
      throw new Error('OTLP metrics exporter requires TEMPORAL_OTLP_ENDPOINT or defaults.telemetry.metricsExporter.url')
    }
    const protocol = env.TEMPORAL_OTLP_PROTOCOL?.trim().toLowerCase()
    if (protocol) {
      if (protocol !== 'http' && protocol !== 'grpc') {
        throw new Error('TEMPORAL_OTLP_PROTOCOL must be either "http" or "grpc"')
      }
      telemetry.metricsExporter.protocol = protocol as 'http' | 'grpc'
    }
    const temporality = env.TEMPORAL_OTLP_METRIC_TEMPORALITY?.trim().toLowerCase()
    if (temporality) {
      if (temporality !== 'cumulative' && temporality !== 'delta') {
        throw new Error('TEMPORAL_OTLP_METRIC_TEMPORALITY must be either "cumulative" or "delta"')
      }
      telemetry.metricsExporter.metricTemporality = temporality as 'cumulative' | 'delta'
    }
    if (globalTags) {
      telemetry.metricsExporter.globalTags = globalTags
      hasValue = true
    }
    if (histogramOverrides) {
      telemetry.metricsExporter.histogramBucketOverrides = histogramOverrides
      hasValue = true
    }
  }

  if (!hasValue) {
    return undefined
  }

  return telemetry
}

const buildTlsConfig = async (
  env: z.infer<typeof envSchema>,
  options: LoadTemporalConfigOptions,
): Promise<TLSConfig | undefined> => {
  const caPath = env.TEMPORAL_TLS_CA_PATH
  const certPath = env.TEMPORAL_TLS_CERT_PATH
  const keyPath = env.TEMPORAL_TLS_KEY_PATH
  const serverName = env.TEMPORAL_TLS_SERVER_NAME

  if (!caPath && !certPath && !keyPath && !serverName) {
    return options.defaults?.tls
  }

  if ((certPath && !keyPath) || (!certPath && keyPath)) {
    throw new Error('Both TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH must be provided for mTLS')
  }

  const reader = options.fs?.readFile ?? readFile
  const tls: TLSConfig = { ...(options.defaults?.tls ?? {}) }

  if (caPath) {
    tls.serverRootCACertificate = await reader(caPath)
  }

  if (certPath && keyPath) {
    tls.clientCertPair = {
      crt: await reader(certPath),
      key: await reader(keyPath),
    }
  }

  if (serverName) {
    tls.serverNameOverride = serverName
  }

  return tls
}

export const loadTemporalConfig = async (options: LoadTemporalConfigOptions = {}): Promise<TemporalConfig> => {
  const env = envSchema.parse(options.env ?? process.env)
  const port = parsePort(env.TEMPORAL_GRPC_PORT)
  const host = env.TEMPORAL_HOST ?? options.defaults?.host ?? DEFAULT_HOST
  const address = env.TEMPORAL_ADDRESS ?? options.defaults?.address ?? `${host}:${port}`
  const namespace = env.TEMPORAL_NAMESPACE ?? options.defaults?.namespace ?? DEFAULT_NAMESPACE
  const taskQueue = env.TEMPORAL_TASK_QUEUE ?? options.defaults?.taskQueue ?? DEFAULT_TASK_QUEUE
  const allowInsecure =
    coerceBoolean(env.TEMPORAL_ALLOW_INSECURE) ??
    coerceBoolean(env.ALLOW_INSECURE_TLS) ??
    options.defaults?.allowInsecureTls ??
    false
  const workerIdentityPrefix =
    env.TEMPORAL_WORKER_IDENTITY_PREFIX ?? options.defaults?.workerIdentityPrefix ?? DEFAULT_IDENTITY_PREFIX
  const workerIdentity = `${workerIdentityPrefix}-${hostname()}-${process.pid}`
  const tls = await buildTlsConfig(env, options)
  const showStackTraceSources =
    coerceBoolean(env.TEMPORAL_SHOW_STACK_SOURCES) ?? options.defaults?.showStackTraceSources ?? false
  const telemetry = buildTelemetryConfig(env, options.defaults)

  return {
    host,
    port,
    address,
    namespace,
    taskQueue,
    apiKey: env.TEMPORAL_API_KEY ?? options.defaults?.apiKey,
    tls,
    allowInsecureTls: allowInsecure,
    workerIdentity,
    workerIdentityPrefix,
    showStackTraceSources,
    telemetry,
  }
}
export const temporalDefaults = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  namespace: DEFAULT_NAMESPACE,
  taskQueue: DEFAULT_TASK_QUEUE,
  workerIdentityPrefix: DEFAULT_IDENTITY_PREFIX,
} satisfies Pick<TemporalConfig, 'host' | 'port' | 'namespace' | 'taskQueue' | 'workerIdentityPrefix'>
