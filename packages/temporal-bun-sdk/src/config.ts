import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'

import type { LogLevel } from './observability/logger'
import { normalizeLogLevel } from './observability/logger'
import type { OtelMeter } from './observability/metrics'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 7233
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_TASK_QUEUE = 'prix'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-worker'
const DEFAULT_STICKY_CACHE_SIZE = 256
const DEFAULT_STICKY_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_STICKY_QUEUE_TIMEOUT_MS = 10_000

interface TemporalEnvironment {
  TEMPORAL_ADDRESS?: string
  TEMPORAL_HOST?: string
  TEMPORAL_GRPC_PORT?: string
  TEMPORAL_NAMESPACE?: string
  TEMPORAL_TASK_QUEUE?: string
  TEMPORAL_API_KEY?: string
  TEMPORAL_TLS_CA_PATH?: string
  TEMPORAL_TLS_CERT_PATH?: string
  TEMPORAL_TLS_KEY_PATH?: string
  TEMPORAL_TLS_SERVER_NAME?: string
  TEMPORAL_ALLOW_INSECURE?: string
  ALLOW_INSECURE_TLS?: string
  TEMPORAL_WORKER_IDENTITY_PREFIX?: string
  TEMPORAL_SHOW_STACK_SOURCES?: string
  TEMPORAL_DISABLE_WORKFLOW_CONTEXT?: string
  TEMPORAL_STICKY_CACHE_SIZE?: string
  TEMPORAL_STICKY_CACHE_TTL_MS?: string
  TEMPORAL_STICKY_QUEUE_TIMEOUT_MS?: string
  TEMPORAL_LOG_LEVEL?: string
  TEMPORAL_LOG_FORMAT?: string
  TEMPORAL_METRICS_EXPORTER?: string
  TEMPORAL_METRICS_METER_NAME?: string
  TEMPORAL_METRICS_METER_VERSION?: string
  TEMPORAL_METRICS_SCHEMA_URL?: string
  TEMPORAL_TRACING_ENABLED?: string
  TEMPORAL_TRACING_EXPORTER?: string
  TEMPORAL_TRACING_SERVICE_NAME?: string
}

const truthyValues = new Set(['1', 'true', 't', 'yes', 'y', 'on'])
const falsyValues = new Set(['0', 'false', 'f', 'no', 'n', 'off'])

const sanitizeEnvironment = (env: NodeJS.ProcessEnv): TemporalEnvironment => {
  const read = (key: string) => {
    const value = env[key]
    if (typeof value !== 'string') {
      return undefined
    }
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }

  return {
    TEMPORAL_ADDRESS: read('TEMPORAL_ADDRESS'),
    TEMPORAL_HOST: read('TEMPORAL_HOST'),
    TEMPORAL_GRPC_PORT: read('TEMPORAL_GRPC_PORT'),
    TEMPORAL_NAMESPACE: read('TEMPORAL_NAMESPACE'),
    TEMPORAL_TASK_QUEUE: read('TEMPORAL_TASK_QUEUE'),
    TEMPORAL_API_KEY: read('TEMPORAL_API_KEY'),
    TEMPORAL_TLS_CA_PATH: read('TEMPORAL_TLS_CA_PATH'),
    TEMPORAL_TLS_CERT_PATH: read('TEMPORAL_TLS_CERT_PATH'),
    TEMPORAL_TLS_KEY_PATH: read('TEMPORAL_TLS_KEY_PATH'),
    TEMPORAL_TLS_SERVER_NAME: read('TEMPORAL_TLS_SERVER_NAME'),
    TEMPORAL_ALLOW_INSECURE: read('TEMPORAL_ALLOW_INSECURE'),
    ALLOW_INSECURE_TLS: read('ALLOW_INSECURE_TLS'),
    TEMPORAL_WORKER_IDENTITY_PREFIX: read('TEMPORAL_WORKER_IDENTITY_PREFIX'),
    TEMPORAL_SHOW_STACK_SOURCES: read('TEMPORAL_SHOW_STACK_SOURCES'),
    TEMPORAL_DISABLE_WORKFLOW_CONTEXT: read('TEMPORAL_DISABLE_WORKFLOW_CONTEXT'),
    TEMPORAL_STICKY_CACHE_SIZE: read('TEMPORAL_STICKY_CACHE_SIZE'),
    TEMPORAL_STICKY_CACHE_TTL_MS: read('TEMPORAL_STICKY_CACHE_TTL_MS'),
    TEMPORAL_STICKY_QUEUE_TIMEOUT_MS: read('TEMPORAL_STICKY_QUEUE_TIMEOUT_MS'),
    TEMPORAL_LOG_LEVEL: read('TEMPORAL_LOG_LEVEL'),
    TEMPORAL_LOG_FORMAT: read('TEMPORAL_LOG_FORMAT'),
    TEMPORAL_METRICS_EXPORTER: read('TEMPORAL_METRICS_EXPORTER'),
    TEMPORAL_METRICS_METER_NAME: read('TEMPORAL_METRICS_METER_NAME'),
    TEMPORAL_METRICS_METER_VERSION: read('TEMPORAL_METRICS_METER_VERSION'),
    TEMPORAL_METRICS_SCHEMA_URL: read('TEMPORAL_METRICS_SCHEMA_URL'),
    TEMPORAL_TRACING_ENABLED: read('TEMPORAL_TRACING_ENABLED'),
    TEMPORAL_TRACING_EXPORTER: read('TEMPORAL_TRACING_EXPORTER'),
    TEMPORAL_TRACING_SERVICE_NAME: read('TEMPORAL_TRACING_SERVICE_NAME'),
  }
}

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

const parseNonNegativeInteger = (raw: string | undefined, fallback: number, label: string): number => {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${raw}`)
  }
  return parsed
}

export interface LoadTemporalConfigOptions {
  env?: NodeJS.ProcessEnv
  fs?: {
    readFile?: typeof readFile
  }
  defaults?: Partial<Omit<TemporalConfig, 'observability'>> & {
    observability?: ObservabilityDefaults
  }
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
  workflowContextBypass: boolean
  stickyCacheSize: number
  stickyCacheTtlMs: number
  stickyQueueTimeoutMs: number
  observability: ObservabilityConfig
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

export interface LoggerConfig {
  level: LogLevel
  format: 'json' | 'pretty'
}

export type MetricsExporter = 'in-memory' | 'otel'

export interface MetricsConfig {
  exporter: MetricsExporter
  meterName?: string
  meterVersion?: string
  schemaUrl?: string
  meter?: OtelMeter
}

export type TracingExporter = 'none' | 'otel'

export interface TracingConfig {
  enabled: boolean
  exporter: TracingExporter
  serviceName?: string
}

export interface ObservabilityConfig {
  logger: LoggerConfig
  metrics: MetricsConfig
  tracing: TracingConfig
}

export type ObservabilityDefaults = Partial<ObservabilityConfig> & {
  logger?: Partial<LoggerConfig>
  metrics?: Partial<MetricsConfig>
  tracing?: Partial<TracingConfig>
}

const normalizeLogFormat = (value: string | undefined): LoggerConfig['format'] =>
  value?.toLowerCase() === 'pretty' ? 'pretty' : 'json'

const normalizeMetricsExporter = (value: string | undefined): MetricsExporter =>
  value?.toLowerCase() === 'otel' ? 'otel' : 'in-memory'

const normalizeTracingExporter = (value: string | undefined): TracingExporter =>
  value?.toLowerCase() === 'otel' ? 'otel' : 'none'

const buildObservabilityConfig = (env: TemporalEnvironment, defaults?: ObservabilityDefaults): ObservabilityConfig => {
  const loggerDefaults = defaults?.logger ?? {}
  const metricsDefaults = defaults?.metrics ?? {}
  const tracingDefaults = defaults?.tracing ?? {}

  const level = normalizeLogLevel(env.TEMPORAL_LOG_LEVEL ?? loggerDefaults.level)
  const format = normalizeLogFormat(env.TEMPORAL_LOG_FORMAT ?? loggerDefaults.format)

  const metricsExporter = normalizeMetricsExporter(env.TEMPORAL_METRICS_EXPORTER ?? metricsDefaults.exporter)
  const metrics: MetricsConfig = {
    exporter: metricsExporter,
    meterName: env.TEMPORAL_METRICS_METER_NAME ?? metricsDefaults.meterName,
    meterVersion: env.TEMPORAL_METRICS_METER_VERSION ?? metricsDefaults.meterVersion,
    schemaUrl: env.TEMPORAL_METRICS_SCHEMA_URL ?? metricsDefaults.schemaUrl,
    meter: metricsDefaults.meter,
  }

  const tracingEnabled = coerceBoolean(env.TEMPORAL_TRACING_ENABLED) ?? tracingDefaults.enabled ?? false
  const tracingExporter = tracingEnabled
    ? normalizeTracingExporter(env.TEMPORAL_TRACING_EXPORTER ?? tracingDefaults.exporter)
    : 'none'
  const tracingServiceName = tracingEnabled
    ? (env.TEMPORAL_TRACING_SERVICE_NAME ?? tracingDefaults.serviceName ?? 'temporal-bun-sdk')
    : tracingDefaults.serviceName

  const tracing: TracingConfig = {
    enabled: tracingEnabled,
    exporter: tracingExporter,
    serviceName: tracingServiceName,
  }

  return {
    logger: {
      level,
      format,
    },
    metrics,
    tracing,
  }
}

const buildTlsConfig = async (
  env: TemporalEnvironment,
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
  // TODO(TBS-010): Convert to Effect + Schema validation, exposing as Config Layer.
  const env = sanitizeEnvironment(options.env ?? process.env)
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
  const workflowContextBypass =
    coerceBoolean(env.TEMPORAL_DISABLE_WORKFLOW_CONTEXT) ?? options.defaults?.workflowContextBypass ?? false
  const stickyCacheSize = parseNonNegativeInteger(
    env.TEMPORAL_STICKY_CACHE_SIZE,
    options.defaults?.stickyCacheSize ?? DEFAULT_STICKY_CACHE_SIZE,
    'Temporal sticky cache size',
  )
  const stickyCacheTtlMs = parseNonNegativeInteger(
    env.TEMPORAL_STICKY_CACHE_TTL_MS,
    options.defaults?.stickyCacheTtlMs ?? DEFAULT_STICKY_CACHE_TTL_MS,
    'Temporal sticky cache TTL (ms)',
  )
  const stickyQueueTimeoutMs = parseNonNegativeInteger(
    env.TEMPORAL_STICKY_QUEUE_TIMEOUT_MS,
    options.defaults?.stickyQueueTimeoutMs ?? DEFAULT_STICKY_QUEUE_TIMEOUT_MS,
    'Temporal sticky queue timeout (ms)',
  )
  const observability = buildObservabilityConfig(env, options.defaults?.observability)

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
    workflowContextBypass,
    stickyCacheSize,
    stickyCacheTtlMs,
    stickyQueueTimeoutMs,
    observability,
  }
}

export const temporalDefaults = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  namespace: DEFAULT_NAMESPACE,
  taskQueue: DEFAULT_TASK_QUEUE,
  workerIdentityPrefix: DEFAULT_IDENTITY_PREFIX,
  workflowContextBypass: false,
  stickyCacheSize: DEFAULT_STICKY_CACHE_SIZE,
  stickyCacheTtlMs: DEFAULT_STICKY_CACHE_TTL_MS,
  stickyQueueTimeoutMs: DEFAULT_STICKY_QUEUE_TIMEOUT_MS,
} satisfies Pick<
  TemporalConfig,
  | 'host'
  | 'port'
  | 'namespace'
  | 'taskQueue'
  | 'workerIdentityPrefix'
  | 'workflowContextBypass'
  | 'stickyCacheSize'
  | 'stickyCacheTtlMs'
  | 'stickyQueueTimeoutMs'
>
