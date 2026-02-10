import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { Code } from '@connectrpc/connect'
import type * as ParseResult from '@effect/schema/ParseResult'
import * as Schema from '@effect/schema/Schema'
import * as TreeFormatter from '@effect/schema/TreeFormatter'
import { Cause, Effect, Exit } from 'effect'
import { defaultRetryPolicy, type TemporalRpcRetryPolicy } from './client/retries'
import type { PayloadCodecConfig } from './common/payloads/codecs'
import type { LogFormat, LogLevel } from './observability/logger'
import type { MetricsExporterSpec } from './observability/metrics'
import {
  cloneMetricsExporterSpec,
  defaultMetricsExporterSpec,
  resolveMetricsExporterSpec,
} from './observability/metrics'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 7233
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_TASK_QUEUE = 'replay-fixtures'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-worker'
const DEFAULT_WORKFLOW_CONCURRENCY = 4
const DEFAULT_ACTIVITY_CONCURRENCY = 4
const DEFAULT_STICKY_CACHE_SIZE = 128
const DEFAULT_STICKY_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS = 5_000
const DEFAULT_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS = 5_000
const DEFAULT_LOG_LEVEL: LogLevel = 'info'
const DEFAULT_LOG_FORMAT: LogFormat = 'pretty'
const DEFAULT_CLOUD_ADDRESS = 'saas-api.tmprl.cloud:443'
const DEFAULT_CLOUD_API_VERSION = '2025-05-31'
const DEFAULT_TRACING_INTERCEPTORS_ENABLED = true
const DEFAULT_DETERMINISM_MARKER_MODE: DeterminismMarkerMode = 'delta'
const DEFAULT_DETERMINISM_MARKER_INTERVAL_TASKS = 10
const DEFAULT_DETERMINISM_MARKER_FULL_SNAPSHOT_INTERVAL_TASKS = 50
const DEFAULT_DETERMINISM_MARKER_SKIP_UNCHANGED = true
const DEFAULT_DETERMINISM_MARKER_MAX_DETAIL_BYTES = 1_800_000
const DEFAULT_WORKFLOW_GUARDS_MODE: WorkflowGuardsMode = 'strict'
const DEFAULT_WORKFLOW_LINT_MODE: WorkflowLintMode = 'warn'
const DEFAULT_CLIENT_RETRY_MAX_ATTEMPTS = defaultRetryPolicy.maxAttempts
const DEFAULT_CLIENT_RETRY_INITIAL_MS = defaultRetryPolicy.initialDelayMs
const DEFAULT_CLIENT_RETRY_MAX_MS = defaultRetryPolicy.maxDelayMs
const DEFAULT_CLIENT_RETRY_BACKOFF = defaultRetryPolicy.backoffCoefficient
const DEFAULT_CLIENT_RETRY_JITTER_FACTOR = defaultRetryPolicy.jitterFactor

const CONNECT_CODE_LOOKUP = (() => {
  const byName = new Map<string, number>()
  const byValue = new Set<number>()
  for (const [key, value] of Object.entries(Code)) {
    if (typeof value === 'number') {
      byName.set(key.toUpperCase(), value)
      byValue.add(value)
    }
  }
  return { byName, byValue }
})()

const cloneRetryPolicy = (policy: TemporalRpcRetryPolicy): TemporalRpcRetryPolicy => ({
  maxAttempts: policy.maxAttempts,
  initialDelayMs: policy.initialDelayMs,
  maxDelayMs: policy.maxDelayMs,
  backoffCoefficient: policy.backoffCoefficient,
  jitterFactor: policy.jitterFactor,
  retryableStatusCodes: [...policy.retryableStatusCodes],
})

const BufferSchema = Schema.instanceOf(Buffer)
const TLSCertPairSchema = Schema.Struct({
  crt: BufferSchema,
  key: BufferSchema,
})
const TLSConfigSchema = Schema.Struct({
  serverRootCACertificate: Schema.optional(BufferSchema),
  serverNameOverride: Schema.optional(Schema.String),
  clientCertPair: Schema.optional(TLSCertPairSchema),
})
const LogLevelSchema = Schema.Literal('debug', 'info', 'warn', 'error')
const LogFormatSchema = Schema.Literal('json', 'pretty')
const DeterminismMarkerModeSchema = Schema.Literal('always', 'interval', 'delta', 'never')
const MetricsExporterTypeSchema = Schema.Literal('in-memory', 'file', 'otlp', 'prometheus')
const WorkflowGuardsModeSchema = Schema.Literal('strict', 'warn', 'off')
const WorkflowLintModeSchema = Schema.Literal('strict', 'warn', 'off')
const MetricsExporterSpecSchema = Schema.Struct({
  type: MetricsExporterTypeSchema,
  endpoint: Schema.optional(Schema.String),
})
const PayloadCodecConfigSchema = Schema.Union(
  Schema.Struct({
    name: Schema.Literal('gzip'),
    order: Schema.optional(Schema.Number),
    enabled: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    name: Schema.Literal('aes-gcm'),
    key: Schema.String,
    keyId: Schema.optional(Schema.String),
    order: Schema.optional(Schema.Number),
    enabled: Schema.optional(Schema.Boolean),
  }),
)
const TemporalRpcRetryPolicySchema = Schema.Struct({
  maxAttempts: Schema.Number,
  initialDelayMs: Schema.Number,
  maxDelayMs: Schema.Number,
  backoffCoefficient: Schema.Number,
  jitterFactor: Schema.Number,
  retryableStatusCodes: Schema.Array(Schema.Number),
})
const TemporalConfigSchema = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  address: Schema.String,
  namespace: Schema.String,
  taskQueue: Schema.String,
  apiKey: Schema.optional(Schema.String),
  cloudAddress: Schema.optional(Schema.String),
  cloudApiKey: Schema.optional(Schema.String),
  cloudApiVersion: Schema.optional(Schema.String),
  tls: Schema.optional(TLSConfigSchema),
  allowInsecureTls: Schema.Boolean,
  workerIdentity: Schema.String,
  workerIdentityPrefix: Schema.String,
  showStackTraceSources: Schema.optional(Schema.Boolean),
  workerWorkflowConcurrency: Schema.Number,
  workerActivityConcurrency: Schema.Number,
  workerStickyCacheSize: Schema.Number,
  workerStickyTtlMs: Schema.Number,
  stickySchedulingEnabled: Schema.Boolean,
  determinismMarkerMode: DeterminismMarkerModeSchema,
  determinismMarkerIntervalTasks: Schema.Number,
  determinismMarkerFullSnapshotIntervalTasks: Schema.Number,
  determinismMarkerSkipUnchanged: Schema.Boolean,
  determinismMarkerMaxDetailBytes: Schema.Number,
  workflowGuards: WorkflowGuardsModeSchema,
  workflowLint: WorkflowLintModeSchema,
  activityHeartbeatIntervalMs: Schema.Number,
  activityHeartbeatRpcTimeoutMs: Schema.Number,
  workerDeploymentName: Schema.optional(Schema.String),
  workerBuildId: Schema.optional(Schema.String),
  logLevel: LogLevelSchema,
  logFormat: LogFormatSchema,
  tracingInterceptorsEnabled: Schema.Boolean,
  metricsExporter: MetricsExporterSpecSchema,
  rpcRetryPolicy: TemporalRpcRetryPolicySchema,
  payloadCodecs: Schema.Array(PayloadCodecConfigSchema),
})
const TemporalConfigOverridesSchema = Schema.partial(TemporalConfigSchema)
const decodeTemporalConfig = Schema.decodeUnknown(TemporalConfigSchema)
const decodeTemporalConfigOverrides = Schema.decodeUnknown(TemporalConfigOverridesSchema)

const formatSchemaError = (error: ParseResult.ParseError): string => TreeFormatter.formatErrorSync(error)
const mapSchemaError = <A>(
  effect: Effect.Effect<A, ParseResult.ParseError, never>,
): Effect.Effect<A, TemporalConfigError, never> =>
  effect.pipe(Effect.mapError((error) => new TemporalConfigError(formatSchemaError(error))))

export interface TemporalEnvironment {
  TEMPORAL_ADDRESS?: string
  TEMPORAL_HOST?: string
  TEMPORAL_GRPC_PORT?: string
  TEMPORAL_NAMESPACE?: string
  TEMPORAL_TASK_QUEUE?: string
  TEMPORAL_API_KEY?: string
  TEMPORAL_CLOUD_ADDRESS?: string
  TEMPORAL_CLOUD_API_KEY?: string
  TEMPORAL_CLOUD_API_VERSION?: string
  TEMPORAL_TLS_CA_PATH?: string
  TEMPORAL_TLS_CERT_PATH?: string
  TEMPORAL_TLS_KEY_PATH?: string
  TEMPORAL_TLS_SERVER_NAME?: string
  TEMPORAL_ALLOW_INSECURE?: string
  ALLOW_INSECURE_TLS?: string
  TEMPORAL_LOG_FORMAT?: string
  TEMPORAL_LOG_LEVEL?: string
  TEMPORAL_TRACING_INTERCEPTORS_ENABLED?: string
  TEMPORAL_METRICS_EXPORTER?: string
  TEMPORAL_METRICS_ENDPOINT?: string
  TEMPORAL_WORKER_IDENTITY_PREFIX?: string
  TEMPORAL_SHOW_STACK_SOURCES?: string
  TEMPORAL_WORKFLOW_CONCURRENCY?: string
  TEMPORAL_ACTIVITY_CONCURRENCY?: string
  TEMPORAL_STICKY_CACHE_SIZE?: string
  TEMPORAL_STICKY_TTL_MS?: string
  TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS?: string
  TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS?: string
  TEMPORAL_WORKER_BUILD_ID?: string
  TEMPORAL_STICKY_SCHEDULING_ENABLED?: string
  TEMPORAL_DETERMINISM_MARKER_MODE?: string
  TEMPORAL_DETERMINISM_MARKER_INTERVAL_TASKS?: string
  TEMPORAL_DETERMINISM_MARKER_FULL_SNAPSHOT_INTERVAL_TASKS?: string
  TEMPORAL_DETERMINISM_MARKER_SKIP_UNCHANGED?: string
  TEMPORAL_DETERMINISM_MARKER_MAX_DETAIL_BYTES?: string
  TEMPORAL_WORKFLOW_LINT?: string
  TEMPORAL_CLIENT_RETRY_MAX_ATTEMPTS?: string
  TEMPORAL_CLIENT_RETRY_INITIAL_MS?: string
  TEMPORAL_CLIENT_RETRY_MAX_MS?: string
  TEMPORAL_CLIENT_RETRY_BACKOFF?: string
  TEMPORAL_CLIENT_RETRY_JITTER_FACTOR?: string
  TEMPORAL_CLIENT_RETRY_STATUS_CODES?: string
  TEMPORAL_PAYLOAD_CODECS?: string
  TEMPORAL_CODEC_AES_KEY?: string
  TEMPORAL_CODEC_AES_KEY_ID?: string
}

const truthyValues = new Set(['1', 'true', 't', 'yes', 'y', 'on'])
const falsyValues = new Set(['0', 'false', 'f', 'no', 'n', 'off'])
const logLevelOptions = new Set<LogLevel>(['debug', 'info', 'warn', 'error'])
const logFormatOptions = new Set<LogFormat>(['json', 'pretty'])
const determinismMarkerModeOptions = new Set<DeterminismMarkerMode>(['always', 'interval', 'delta', 'never'])
const workflowLintModeOptions = new Set<WorkflowLintMode>(['strict', 'warn', 'off'])

const parseLogLevel = (value: string | undefined): LogLevel | undefined => {
  if (!value) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) {
    return undefined
  }
  if (logLevelOptions.has(normalized as LogLevel)) {
    return normalized as LogLevel
  }
  throw new TemporalConfigError(`Invalid TEMPORAL_LOG_LEVEL: ${value}`)
}

const parseLogFormat = (value: string | undefined): LogFormat | undefined => {
  if (!value) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) {
    return undefined
  }
  if (logFormatOptions.has(normalized as LogFormat)) {
    return normalized as LogFormat
  }
  throw new TemporalConfigError(`Invalid TEMPORAL_LOG_FORMAT: ${value}`)
}

const parseDeterminismMarkerMode = (value: string | undefined): DeterminismMarkerMode | undefined => {
  if (!value) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) {
    return undefined
  }
  if (determinismMarkerModeOptions.has(normalized as DeterminismMarkerMode)) {
    return normalized as DeterminismMarkerMode
  }
  throw new TemporalConfigError(`Invalid TEMPORAL_DETERMINISM_MARKER_MODE: ${value}`)
}

const parseWorkflowLintMode = (value: string | undefined): WorkflowLintMode | undefined => {
  if (!value) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) {
    return undefined
  }
  if (workflowLintModeOptions.has(normalized as WorkflowLintMode)) {
    return normalized as WorkflowLintMode
  }
  throw new TemporalConfigError(`Invalid TEMPORAL_WORKFLOW_LINT: ${value}`)
}

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
    TEMPORAL_LOG_FORMAT: read('TEMPORAL_LOG_FORMAT'),
    TEMPORAL_LOG_LEVEL: read('TEMPORAL_LOG_LEVEL'),
    TEMPORAL_TRACING_INTERCEPTORS_ENABLED: read('TEMPORAL_TRACING_INTERCEPTORS_ENABLED'),
    TEMPORAL_METRICS_EXPORTER: read('TEMPORAL_METRICS_EXPORTER'),
    TEMPORAL_METRICS_ENDPOINT: read('TEMPORAL_METRICS_ENDPOINT'),
    TEMPORAL_WORKER_IDENTITY_PREFIX: read('TEMPORAL_WORKER_IDENTITY_PREFIX'),
    TEMPORAL_SHOW_STACK_SOURCES: read('TEMPORAL_SHOW_STACK_SOURCES'),
    TEMPORAL_WORKFLOW_CONCURRENCY: read('TEMPORAL_WORKFLOW_CONCURRENCY'),
    TEMPORAL_ACTIVITY_CONCURRENCY: read('TEMPORAL_ACTIVITY_CONCURRENCY'),
    TEMPORAL_STICKY_CACHE_SIZE: read('TEMPORAL_STICKY_CACHE_SIZE'),
    TEMPORAL_STICKY_TTL_MS: read('TEMPORAL_STICKY_TTL_MS'),
    TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS: read('TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS'),
    TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS: read('TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS'),
    TEMPORAL_WORKER_BUILD_ID: read('TEMPORAL_WORKER_BUILD_ID'),
    TEMPORAL_STICKY_SCHEDULING_ENABLED: read('TEMPORAL_STICKY_SCHEDULING_ENABLED'),
    TEMPORAL_DETERMINISM_MARKER_MODE: read('TEMPORAL_DETERMINISM_MARKER_MODE'),
    TEMPORAL_DETERMINISM_MARKER_INTERVAL_TASKS: read('TEMPORAL_DETERMINISM_MARKER_INTERVAL_TASKS'),
    TEMPORAL_DETERMINISM_MARKER_FULL_SNAPSHOT_INTERVAL_TASKS: read(
      'TEMPORAL_DETERMINISM_MARKER_FULL_SNAPSHOT_INTERVAL_TASKS',
    ),
    TEMPORAL_DETERMINISM_MARKER_SKIP_UNCHANGED: read('TEMPORAL_DETERMINISM_MARKER_SKIP_UNCHANGED'),
    TEMPORAL_DETERMINISM_MARKER_MAX_DETAIL_BYTES: read('TEMPORAL_DETERMINISM_MARKER_MAX_DETAIL_BYTES'),
    TEMPORAL_WORKFLOW_LINT: read('TEMPORAL_WORKFLOW_LINT'),
    TEMPORAL_CLIENT_RETRY_MAX_ATTEMPTS: read('TEMPORAL_CLIENT_RETRY_MAX_ATTEMPTS'),
    TEMPORAL_CLIENT_RETRY_INITIAL_MS: read('TEMPORAL_CLIENT_RETRY_INITIAL_MS'),
    TEMPORAL_CLIENT_RETRY_MAX_MS: read('TEMPORAL_CLIENT_RETRY_MAX_MS'),
    TEMPORAL_CLIENT_RETRY_BACKOFF: read('TEMPORAL_CLIENT_RETRY_BACKOFF'),
    TEMPORAL_CLIENT_RETRY_JITTER_FACTOR: read('TEMPORAL_CLIENT_RETRY_JITTER_FACTOR'),
    TEMPORAL_CLIENT_RETRY_STATUS_CODES: read('TEMPORAL_CLIENT_RETRY_STATUS_CODES'),
    TEMPORAL_PAYLOAD_CODECS: read('TEMPORAL_PAYLOAD_CODECS'),
    TEMPORAL_CODEC_AES_KEY: read('TEMPORAL_CODEC_AES_KEY'),
    TEMPORAL_CODEC_AES_KEY_ID: read('TEMPORAL_CODEC_AES_KEY_ID'),
  }
}

export const resolveTemporalEnvironment = (env?: NodeJS.ProcessEnv): TemporalEnvironment =>
  sanitizeEnvironment(env ?? process.env)

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
    throw new TemporalConfigError(`Invalid Temporal gRPC port: ${raw}`)
  }
  return parsed
}

const parsePositiveInt = (raw: string | undefined, fallback: number, context: string): number => {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TemporalConfigError(`Invalid ${context}: ${raw}`)
  }
  return parsed
}

const parseNonNegativeInt = (raw: string | undefined, fallback: number, context: string): number => {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TemporalConfigError(`Invalid ${context}: ${raw}`)
  }
  return parsed
}

const parsePositiveNumber = (raw: string | undefined, fallback: number, context: string): number => {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TemporalConfigError(`Invalid ${context}: ${raw}`)
  }
  return parsed
}

const parseNonNegativeNumber = (raw: string | undefined, fallback: number, context: string): number => {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TemporalConfigError(`Invalid ${context}: ${raw}`)
  }
  return parsed
}

const clampJitterFactor = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  if (value >= 1) {
    return 1
  }
  return value
}

const parseRetryStatusCodes = (raw: string | undefined, fallback: ReadonlyArray<number>): number[] => {
  if (raw === undefined) {
    return [...fallback]
  }
  const tokens = raw
    .split(/[,\s]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  if (tokens.length === 0) {
    throw new TemporalConfigError('TEMPORAL_CLIENT_RETRY_STATUS_CODES must include at least one status code')
  }

  const resolved = new Set<number>()

  for (const token of tokens) {
    const numeric = Number.parseInt(token, 10)
    if (Number.isInteger(numeric)) {
      if (!CONNECT_CODE_LOOKUP.byValue.has(numeric)) {
        throw new TemporalConfigError(`Unknown retry status code: ${token}`)
      }
      resolved.add(numeric)
      continue
    }
    const value = CONNECT_CODE_LOOKUP.byName.get(token.toUpperCase())
    if (value === undefined) {
      throw new TemporalConfigError(`Unknown retry status code: ${token}`)
    }
    resolved.add(value)
  }

  if (resolved.size === 0) {
    throw new TemporalConfigError('TEMPORAL_CLIENT_RETRY_STATUS_CODES must include at least one status code')
  }

  return [...resolved]
}

const parsePayloadCodecs = (
  env: TemporalEnvironment,
  defaults?: readonly PayloadCodecConfig[],
): PayloadCodecConfig[] => {
  const raw = env.TEMPORAL_PAYLOAD_CODECS
  if (!raw) {
    return defaults ? [...defaults] : []
  }
  const names = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  if (names.length === 0) {
    return []
  }

  const configs: PayloadCodecConfig[] = []
  names.forEach((name, index) => {
    if (name === 'gzip') {
      configs.push({ name: 'gzip', order: index })
      return
    }
    if (name === 'aes-gcm') {
      const key = env.TEMPORAL_CODEC_AES_KEY ?? defaults?.find((c) => c.name === 'aes-gcm')?.key
      if (!key) {
        throw new TemporalConfigError('TEMPORAL_CODEC_AES_KEY is required when enabling aes-gcm payload codec')
      }
      configs.push({
        name: 'aes-gcm',
        key,
        keyId: env.TEMPORAL_CODEC_AES_KEY_ID,
        order: index,
      })
      return
    }
    throw new TemporalConfigError(`Unknown payload codec "${name}" in TEMPORAL_PAYLOAD_CODECS`)
  })

  return configs
}

export interface LoadTemporalConfigOptions {
  env?: NodeJS.ProcessEnv
  fs?: {
    readFile?: typeof readFile
  }
  defaults?: Partial<TemporalConfig>
}

export type DeterminismMarkerMode = 'always' | 'interval' | 'delta' | 'never'
export type WorkflowGuardsMode = 'strict' | 'warn' | 'off'
export type WorkflowLintMode = 'strict' | 'warn' | 'off'

export interface TemporalConfig {
  host: string
  port: number
  address: string
  namespace: string
  taskQueue: string
  apiKey?: string
  cloudAddress?: string
  cloudApiKey?: string
  cloudApiVersion?: string
  tls?: TLSConfig
  allowInsecureTls: boolean
  workerIdentity: string
  workerIdentityPrefix: string
  showStackTraceSources?: boolean
  workerWorkflowConcurrency: number
  workerActivityConcurrency: number
  workerStickyCacheSize: number
  workerStickyTtlMs: number
  stickySchedulingEnabled: boolean
  determinismMarkerMode: DeterminismMarkerMode
  determinismMarkerIntervalTasks: number
  determinismMarkerFullSnapshotIntervalTasks: number
  determinismMarkerSkipUnchanged: boolean
  determinismMarkerMaxDetailBytes: number
  workflowGuards: WorkflowGuardsMode
  workflowLint: WorkflowLintMode
  activityHeartbeatIntervalMs: number
  activityHeartbeatRpcTimeoutMs: number
  workerDeploymentName?: string
  workerBuildId?: string
  logLevel: LogLevel
  logFormat: LogFormat
  tracingInterceptorsEnabled: boolean
  metricsExporter: MetricsExporterSpec
  rpcRetryPolicy: TemporalRpcRetryPolicy
  payloadCodecs: readonly PayloadCodecConfig[]
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

export class TemporalConfigError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'TemporalConfigError'
  }
}

const describeFsError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export class TemporalTlsConfigurationError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'TemporalTlsConfigurationError'
  }
}

const readTlsFile = async (path: string, context: string, reader: typeof readFile): Promise<Buffer> => {
  try {
    const contents = await reader(path)
    let buffer: Buffer
    if (typeof contents === 'string') {
      buffer = Buffer.from(contents)
    } else if (Buffer.isBuffer(contents)) {
      buffer = contents
    } else {
      buffer = Buffer.from(contents as ArrayBufferLike)
    }
    if (buffer.byteLength === 0) {
      throw new TemporalTlsConfigurationError(`${context} at ${path} is empty`)
    }
    return buffer
  } catch (error) {
    if (error instanceof TemporalTlsConfigurationError) {
      throw error
    }
    throw new TemporalTlsConfigurationError(`Failed to read ${context} at ${path}`, {
      reason: describeFsError(error),
    })
  }
}

const ensureCertificateBuffer = (buffer: Buffer, context: string): void => {
  if (!buffer.toString('utf8').includes('BEGIN CERTIFICATE')) {
    throw new TemporalTlsConfigurationError(`${context} must be a PEM-encoded certificate`)
  }
}

const ensurePrivateKeyBuffer = (buffer: Buffer, context: string): void => {
  try {
    createPrivateKey({ key: buffer })
  } catch (error) {
    throw new TemporalTlsConfigurationError(`${context} must be a PEM-encoded private key`, {
      reason: describeFsError(error),
    })
  }
}

const coerceToBuffer = (value: string | Buffer): Buffer => {
  return Buffer.isBuffer(value) ? value : Buffer.from(value)
}

const ensureMatchingCertificateAndKey = (certificate: Buffer, key: Buffer): void => {
  try {
    const parsed = new X509Certificate(certificate)
    const keyObject = createPrivateKey({ key })
    const certPublicKey = parsed.publicKey.export({ type: 'spki', format: 'pem' })
    const keyPublic = createPublicKey(keyObject).export({ type: 'spki', format: 'pem' })
    if (!coerceToBuffer(certPublicKey).equals(coerceToBuffer(keyPublic))) {
      throw new TemporalTlsConfigurationError('TLS certificate and key do not match')
    }
  } catch (error) {
    if (error instanceof TemporalTlsConfigurationError) {
      throw error
    }
    throw new TemporalTlsConfigurationError('TLS certificate and key do not match', {
      reason: describeFsError(error),
    })
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
    throw new TemporalTlsConfigurationError(
      'Both TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH must be provided for mTLS',
    )
  }

  const reader = options.fs?.readFile ?? readFile
  const tls: TLSConfig = { ...(options.defaults?.tls ?? {}) }

  if (caPath) {
    const caBuffer = await readTlsFile(caPath, 'TEMPORAL_TLS_CA_PATH', reader)
    ensureCertificateBuffer(caBuffer, 'TEMPORAL_TLS_CA_PATH')
    tls.serverRootCACertificate = caBuffer
  }

  if (certPath && keyPath) {
    const crt = await readTlsFile(certPath, 'TEMPORAL_TLS_CERT_PATH', reader)
    const key = await readTlsFile(keyPath, 'TEMPORAL_TLS_KEY_PATH', reader)
    ensureCertificateBuffer(crt, 'TEMPORAL_TLS_CERT_PATH')
    ensurePrivateKeyBuffer(key, 'TEMPORAL_TLS_KEY_PATH')
    ensureMatchingCertificateAndKey(crt, key)
    tls.clientCertPair = { crt, key }
  }

  if (serverName) {
    const trimmed = serverName.trim()
    if (!trimmed) {
      throw new TemporalTlsConfigurationError('TEMPORAL_TLS_SERVER_NAME must be a non-empty string')
    }
    tls.serverNameOverride = trimmed
  }

  return tls
}

const resolveClientRetryPolicy = (
  env: TemporalEnvironment,
  defaults?: TemporalRpcRetryPolicy,
): TemporalRpcRetryPolicy => {
  const fallback = cloneRetryPolicy(defaults ?? defaultRetryPolicy)
  const maxAttempts = parsePositiveInt(
    env.TEMPORAL_CLIENT_RETRY_MAX_ATTEMPTS,
    fallback.maxAttempts ?? DEFAULT_CLIENT_RETRY_MAX_ATTEMPTS,
    'TEMPORAL_CLIENT_RETRY_MAX_ATTEMPTS',
  )
  const initialDelayMs = parsePositiveInt(
    env.TEMPORAL_CLIENT_RETRY_INITIAL_MS,
    fallback.initialDelayMs ?? DEFAULT_CLIENT_RETRY_INITIAL_MS,
    'TEMPORAL_CLIENT_RETRY_INITIAL_MS',
  )
  const maxDelayMs = parsePositiveInt(
    env.TEMPORAL_CLIENT_RETRY_MAX_MS,
    fallback.maxDelayMs ?? DEFAULT_CLIENT_RETRY_MAX_MS,
    'TEMPORAL_CLIENT_RETRY_MAX_MS',
  )
  if (maxDelayMs < initialDelayMs) {
    throw new TemporalConfigError(
      'TEMPORAL_CLIENT_RETRY_MAX_MS must be greater than or equal to TEMPORAL_CLIENT_RETRY_INITIAL_MS',
    )
  }
  const backoffCoefficient = parsePositiveNumber(
    env.TEMPORAL_CLIENT_RETRY_BACKOFF,
    fallback.backoffCoefficient ?? DEFAULT_CLIENT_RETRY_BACKOFF,
    'TEMPORAL_CLIENT_RETRY_BACKOFF',
  )
  const jitterFactor = clampJitterFactor(
    parseNonNegativeNumber(
      env.TEMPORAL_CLIENT_RETRY_JITTER_FACTOR,
      fallback.jitterFactor ?? DEFAULT_CLIENT_RETRY_JITTER_FACTOR,
      'TEMPORAL_CLIENT_RETRY_JITTER_FACTOR',
    ),
  )
  const retryableStatusCodes = parseRetryStatusCodes(
    env.TEMPORAL_CLIENT_RETRY_STATUS_CODES,
    fallback.retryableStatusCodes.length > 0 ? fallback.retryableStatusCodes : defaultRetryPolicy.retryableStatusCodes,
  )

  return {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffCoefficient,
    jitterFactor,
    retryableStatusCodes,
  }
}

export const loadTemporalConfigEffect = (
  options: LoadTemporalConfigOptions = {},
): Effect.Effect<TemporalConfig, TemporalConfigError | TemporalTlsConfigurationError> =>
  Effect.gen(function* () {
    const defaults = yield* mapSchemaError(decodeTemporalConfigOverrides(options.defaults ?? {}))
    const env = resolveTemporalEnvironment(options.env)
    const normalizedOptions: LoadTemporalConfigOptions = { ...options, defaults }
    const port = parsePort(env.TEMPORAL_GRPC_PORT ?? (defaults.port ? `${defaults.port}` : undefined))
    const host = env.TEMPORAL_HOST ?? defaults.host ?? DEFAULT_HOST
    const address = env.TEMPORAL_ADDRESS ?? defaults.address ?? `${host}:${port}`
    const namespace = env.TEMPORAL_NAMESPACE ?? defaults.namespace ?? DEFAULT_NAMESPACE
    const taskQueue = env.TEMPORAL_TASK_QUEUE ?? defaults.taskQueue ?? DEFAULT_TASK_QUEUE
    const fallbackWorkflowConcurrency = defaults.workerWorkflowConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY
    const fallbackActivityConcurrency = defaults.workerActivityConcurrency ?? DEFAULT_ACTIVITY_CONCURRENCY
    const fallbackStickyCacheSize = defaults.workerStickyCacheSize ?? DEFAULT_STICKY_CACHE_SIZE
    const fallbackStickyTtl = defaults.workerStickyTtlMs ?? DEFAULT_STICKY_CACHE_TTL_MS
    const workerWorkflowConcurrency = parsePositiveInt(
      env.TEMPORAL_WORKFLOW_CONCURRENCY,
      fallbackWorkflowConcurrency,
      'TEMPORAL_WORKFLOW_CONCURRENCY',
    )
    const workerActivityConcurrency = parsePositiveInt(
      env.TEMPORAL_ACTIVITY_CONCURRENCY,
      fallbackActivityConcurrency,
      'TEMPORAL_ACTIVITY_CONCURRENCY',
    )
    const workerStickyCacheSize = parseNonNegativeInt(
      env.TEMPORAL_STICKY_CACHE_SIZE,
      fallbackStickyCacheSize,
      'TEMPORAL_STICKY_CACHE_SIZE',
    )
    const workerStickyTtlMs = parseNonNegativeInt(
      env.TEMPORAL_STICKY_TTL_MS,
      fallbackStickyTtl,
      'TEMPORAL_STICKY_TTL_MS',
    )
    const stickySchedulingEnabled =
      coerceBoolean(env.TEMPORAL_STICKY_SCHEDULING_ENABLED) ??
      defaults.stickySchedulingEnabled ??
      workerStickyCacheSize > 0
    const determinismMarkerMode =
      parseDeterminismMarkerMode(env.TEMPORAL_DETERMINISM_MARKER_MODE) ??
      defaults.determinismMarkerMode ??
      DEFAULT_DETERMINISM_MARKER_MODE
    const determinismMarkerIntervalTasks = parsePositiveInt(
      env.TEMPORAL_DETERMINISM_MARKER_INTERVAL_TASKS,
      defaults.determinismMarkerIntervalTasks ?? DEFAULT_DETERMINISM_MARKER_INTERVAL_TASKS,
      'TEMPORAL_DETERMINISM_MARKER_INTERVAL_TASKS',
    )
    const determinismMarkerFullSnapshotIntervalTasks = parsePositiveInt(
      env.TEMPORAL_DETERMINISM_MARKER_FULL_SNAPSHOT_INTERVAL_TASKS,
      defaults.determinismMarkerFullSnapshotIntervalTasks ?? DEFAULT_DETERMINISM_MARKER_FULL_SNAPSHOT_INTERVAL_TASKS,
      'TEMPORAL_DETERMINISM_MARKER_FULL_SNAPSHOT_INTERVAL_TASKS',
    )
    const determinismMarkerSkipUnchanged =
      coerceBoolean(env.TEMPORAL_DETERMINISM_MARKER_SKIP_UNCHANGED) ??
      defaults.determinismMarkerSkipUnchanged ??
      DEFAULT_DETERMINISM_MARKER_SKIP_UNCHANGED
    const determinismMarkerMaxDetailBytes = parsePositiveInt(
      env.TEMPORAL_DETERMINISM_MARKER_MAX_DETAIL_BYTES,
      defaults.determinismMarkerMaxDetailBytes ?? DEFAULT_DETERMINISM_MARKER_MAX_DETAIL_BYTES,
      'TEMPORAL_DETERMINISM_MARKER_MAX_DETAIL_BYTES',
    )
    const workflowGuards = defaults.workflowGuards ?? DEFAULT_WORKFLOW_GUARDS_MODE
    const workflowLint =
      parseWorkflowLintMode(env.TEMPORAL_WORKFLOW_LINT) ?? defaults.workflowLint ?? DEFAULT_WORKFLOW_LINT_MODE
    const fallbackHeartbeatInterval = defaults.activityHeartbeatIntervalMs ?? DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS
    const fallbackHeartbeatRpcTimeout =
      defaults.activityHeartbeatRpcTimeoutMs ?? DEFAULT_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS
    const activityHeartbeatIntervalMs = parsePositiveInt(
      env.TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS,
      fallbackHeartbeatInterval,
      'TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS',
    )
    const activityHeartbeatRpcTimeoutMs = parsePositiveInt(
      env.TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS,
      fallbackHeartbeatRpcTimeout,
      'TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS',
    )
    const workerDeploymentName = defaults.workerDeploymentName
    const workerBuildId = env.TEMPORAL_WORKER_BUILD_ID ?? defaults.workerBuildId
    const allowInsecureTls =
      coerceBoolean(env.TEMPORAL_ALLOW_INSECURE) ??
      coerceBoolean(env.ALLOW_INSECURE_TLS) ??
      defaults.allowInsecureTls ??
      false
    const workerIdentityPrefix =
      env.TEMPORAL_WORKER_IDENTITY_PREFIX ?? defaults.workerIdentityPrefix ?? DEFAULT_IDENTITY_PREFIX
    const workerIdentity = defaults.workerIdentity ?? `${workerIdentityPrefix}-${hostname()}-${process.pid}`
    const tls = yield* Effect.tryPromise({
      try: () => buildTlsConfig(env, normalizedOptions),
      catch: (error) => error,
    })
    const showStackTraceSources =
      coerceBoolean(env.TEMPORAL_SHOW_STACK_SOURCES) ?? defaults.showStackTraceSources ?? false
    const logLevel = parseLogLevel(env.TEMPORAL_LOG_LEVEL) ?? defaults.logLevel ?? DEFAULT_LOG_LEVEL
    const logFormat = parseLogFormat(env.TEMPORAL_LOG_FORMAT) ?? defaults.logFormat ?? DEFAULT_LOG_FORMAT
    const tracingInterceptorsEnabled =
      coerceBoolean(env.TEMPORAL_TRACING_INTERCEPTORS_ENABLED) ??
      defaults.tracingInterceptorsEnabled ??
      DEFAULT_TRACING_INTERCEPTORS_ENABLED
    const metricsExporter = resolveMetricsExporterSpec(
      env.TEMPORAL_METRICS_EXPORTER ?? defaults.metricsExporter?.type,
      env.TEMPORAL_METRICS_ENDPOINT ?? defaults.metricsExporter?.endpoint,
    )
    const rpcRetryPolicy = resolveClientRetryPolicy(env, defaults.rpcRetryPolicy)
    const payloadCodecs = parsePayloadCodecs(env, defaults.payloadCodecs)
    const configuredCloudAddress = env.TEMPORAL_CLOUD_ADDRESS ?? defaults.cloudAddress
    const cloudApiKey = env.TEMPORAL_CLOUD_API_KEY ?? defaults.cloudApiKey
    const resolvedCloudAddress =
      configuredCloudAddress ?? (cloudApiKey || env.TEMPORAL_CLOUD_API_VERSION ? DEFAULT_CLOUD_ADDRESS : undefined)
    const cloudApiVersion =
      env.TEMPORAL_CLOUD_API_VERSION ??
      defaults.cloudApiVersion ??
      (resolvedCloudAddress ? DEFAULT_CLOUD_API_VERSION : undefined)

    const config: TemporalConfig = {
      host,
      port,
      address,
      namespace,
      taskQueue,
      apiKey: env.TEMPORAL_API_KEY ?? defaults.apiKey,
      cloudAddress: resolvedCloudAddress,
      cloudApiKey,
      cloudApiVersion,
      tls,
      allowInsecureTls,
      workerIdentity,
      workerIdentityPrefix,
      showStackTraceSources,
      workerWorkflowConcurrency,
      workerActivityConcurrency,
      workerStickyCacheSize,
      workerStickyTtlMs,
      stickySchedulingEnabled,
      determinismMarkerMode,
      determinismMarkerIntervalTasks,
      determinismMarkerFullSnapshotIntervalTasks,
      determinismMarkerSkipUnchanged,
      determinismMarkerMaxDetailBytes,
      workflowGuards,
      workflowLint,
      activityHeartbeatIntervalMs,
      activityHeartbeatRpcTimeoutMs,
      workerDeploymentName,
      workerBuildId,
      logLevel,
      logFormat,
      tracingInterceptorsEnabled,
      metricsExporter,
      rpcRetryPolicy,
      payloadCodecs,
    }

    return yield* mapSchemaError(decodeTemporalConfig(config))
  }) as Effect.Effect<TemporalConfig, TemporalConfigError | TemporalTlsConfigurationError, never>

export const loadTemporalConfig = async (options: LoadTemporalConfigOptions = {}): Promise<TemporalConfig> => {
  const exit = await Effect.runPromiseExit(loadTemporalConfigEffect(options))
  if (Exit.isSuccess(exit)) {
    return exit.value
  }
  throw Cause.squash(exit.cause)
}

export const applyTemporalConfigOverrides = (
  config: TemporalConfig,
  overrides?: Partial<TemporalConfig>,
): Effect.Effect<TemporalConfig, TemporalConfigError> =>
  mapSchemaError(decodeTemporalConfigOverrides(overrides ?? {})).pipe(
    Effect.map((validated) => ({ ...config, ...validated })),
    Effect.flatMap((merged) => mapSchemaError(decodeTemporalConfig(merged))),
  )

export const temporalDefaults = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  namespace: DEFAULT_NAMESPACE,
  taskQueue: DEFAULT_TASK_QUEUE,
  cloudAddress: undefined,
  cloudApiKey: undefined,
  cloudApiVersion: undefined,
  workerIdentityPrefix: DEFAULT_IDENTITY_PREFIX,
  workerWorkflowConcurrency: DEFAULT_WORKFLOW_CONCURRENCY,
  workerActivityConcurrency: DEFAULT_ACTIVITY_CONCURRENCY,
  workerStickyCacheSize: DEFAULT_STICKY_CACHE_SIZE,
  workerStickyTtlMs: DEFAULT_STICKY_CACHE_TTL_MS,
  stickySchedulingEnabled: true,
  determinismMarkerMode: DEFAULT_DETERMINISM_MARKER_MODE,
  determinismMarkerIntervalTasks: DEFAULT_DETERMINISM_MARKER_INTERVAL_TASKS,
  determinismMarkerFullSnapshotIntervalTasks: DEFAULT_DETERMINISM_MARKER_FULL_SNAPSHOT_INTERVAL_TASKS,
  determinismMarkerSkipUnchanged: DEFAULT_DETERMINISM_MARKER_SKIP_UNCHANGED,
  determinismMarkerMaxDetailBytes: DEFAULT_DETERMINISM_MARKER_MAX_DETAIL_BYTES,
  workflowGuards: DEFAULT_WORKFLOW_GUARDS_MODE,
  workflowLint: DEFAULT_WORKFLOW_LINT_MODE,
  activityHeartbeatIntervalMs: DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS,
  activityHeartbeatRpcTimeoutMs: DEFAULT_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS,
  workerDeploymentName: undefined,
  workerBuildId: undefined,
  logLevel: DEFAULT_LOG_LEVEL,
  logFormat: DEFAULT_LOG_FORMAT,
  tracingInterceptorsEnabled: DEFAULT_TRACING_INTERCEPTORS_ENABLED,
  metricsExporter: cloneMetricsExporterSpec(defaultMetricsExporterSpec),
  rpcRetryPolicy: cloneRetryPolicy(defaultRetryPolicy),
  payloadCodecs: [],
} satisfies Pick<
  TemporalConfig,
  | 'host'
  | 'port'
  | 'namespace'
  | 'taskQueue'
  | 'cloudAddress'
  | 'cloudApiKey'
  | 'cloudApiVersion'
  | 'workerIdentityPrefix'
  | 'workerWorkflowConcurrency'
  | 'workerActivityConcurrency'
  | 'workerStickyCacheSize'
  | 'workerStickyTtlMs'
  | 'stickySchedulingEnabled'
  | 'determinismMarkerMode'
  | 'determinismMarkerIntervalTasks'
  | 'determinismMarkerFullSnapshotIntervalTasks'
  | 'determinismMarkerSkipUnchanged'
  | 'determinismMarkerMaxDetailBytes'
  | 'workflowGuards'
  | 'workflowLint'
  | 'activityHeartbeatIntervalMs'
  | 'activityHeartbeatRpcTimeoutMs'
  | 'workerDeploymentName'
  | 'workerBuildId'
  | 'logLevel'
  | 'logFormat'
  | 'tracingInterceptorsEnabled'
  | 'metricsExporter'
  | 'rpcRetryPolicy'
  | 'payloadCodecs'
>
