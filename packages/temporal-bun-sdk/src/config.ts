import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'

import { createDefaultHeaders, mergeHeaders, normalizeMetadataHeaders } from './client/headers'

const readEnvValue = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key]
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 7233
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_TASK_QUEUE = 'prix'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-worker'
const DEFAULT_WORKFLOW_CONCURRENCY = 4
const DEFAULT_ACTIVITY_CONCURRENCY = 4
const DEFAULT_STICKY_CACHE_SIZE = 128
const DEFAULT_STICKY_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS = 5_000
const DEFAULT_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS = 5_000
const DEFAULT_GRAF_SERVICE_URL = 'http://graf-service.graf.svc.cluster.local:8080'
const DEFAULT_SUPPLY_CHAIN_ARTIFACT_CONFIDENCE_THRESHOLD = 0.75
const DEFAULT_GRAF_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_GRAF_RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504]
const DEFAULT_GRAF_RETRY_MAX_ATTEMPTS = 3
const DEFAULT_GRAF_RETRY_INITIAL_DELAY_MS = 500
const DEFAULT_GRAF_RETRY_MAX_DELAY_MS = 3_000
const DEFAULT_GRAF_RETRY_BACKOFF_COEFFICIENT = 2

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
  TEMPORAL_WORKFLOW_CONCURRENCY?: string
  TEMPORAL_ACTIVITY_CONCURRENCY?: string
  TEMPORAL_STICKY_CACHE_SIZE?: string
  TEMPORAL_STICKY_TTL_MS?: string
  TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS?: string
  TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS?: string
  TEMPORAL_WORKER_DEPLOYMENT_NAME?: string
  TEMPORAL_WORKER_BUILD_ID?: string
}

interface GrafEnvironment {
  GRAF_SERVICE_URL?: string
  GRAF_API_KEY?: string
  GRAF_AUTH_HEADERS?: string
  SUPPLY_CHAIN_ARTIFACT_CONFIDENCE_THRESHOLD?: string
  GRAF_REQUEST_TIMEOUT_MS?: string
  GRAF_RETRY_MAX_ATTEMPTS?: string
  GRAF_RETRY_INITIAL_DELAY_MS?: string
  GRAF_RETRY_MAX_DELAY_MS?: string
  GRAF_RETRY_BACKOFF_COEFFICIENT?: string
  GRAF_RETRYABLE_STATUS_CODES?: string
}

const truthyValues = new Set(['1', 'true', 't', 'yes', 'y', 'on'])
const falsyValues = new Set(['0', 'false', 'f', 'no', 'n', 'off'])

const sanitizeEnvironment = (env: NodeJS.ProcessEnv): TemporalEnvironment => {
  return {
    TEMPORAL_ADDRESS: readEnvValue(env, 'TEMPORAL_ADDRESS'),
    TEMPORAL_HOST: readEnvValue(env, 'TEMPORAL_HOST'),
    TEMPORAL_GRPC_PORT: readEnvValue(env, 'TEMPORAL_GRPC_PORT'),
    TEMPORAL_NAMESPACE: readEnvValue(env, 'TEMPORAL_NAMESPACE'),
    TEMPORAL_TASK_QUEUE: readEnvValue(env, 'TEMPORAL_TASK_QUEUE'),
    TEMPORAL_API_KEY: readEnvValue(env, 'TEMPORAL_API_KEY'),
    TEMPORAL_TLS_CA_PATH: readEnvValue(env, 'TEMPORAL_TLS_CA_PATH'),
    TEMPORAL_TLS_CERT_PATH: readEnvValue(env, 'TEMPORAL_TLS_CERT_PATH'),
    TEMPORAL_TLS_KEY_PATH: readEnvValue(env, 'TEMPORAL_TLS_KEY_PATH'),
    TEMPORAL_TLS_SERVER_NAME: readEnvValue(env, 'TEMPORAL_TLS_SERVER_NAME'),
    TEMPORAL_ALLOW_INSECURE: readEnvValue(env, 'TEMPORAL_ALLOW_INSECURE'),
    ALLOW_INSECURE_TLS: readEnvValue(env, 'ALLOW_INSECURE_TLS'),
    TEMPORAL_WORKER_IDENTITY_PREFIX: readEnvValue(env, 'TEMPORAL_WORKER_IDENTITY_PREFIX'),
    TEMPORAL_SHOW_STACK_SOURCES: readEnvValue(env, 'TEMPORAL_SHOW_STACK_SOURCES'),
    TEMPORAL_WORKFLOW_CONCURRENCY: readEnvValue(env, 'TEMPORAL_WORKFLOW_CONCURRENCY'),
    TEMPORAL_ACTIVITY_CONCURRENCY: readEnvValue(env, 'TEMPORAL_ACTIVITY_CONCURRENCY'),
    TEMPORAL_STICKY_CACHE_SIZE: readEnvValue(env, 'TEMPORAL_STICKY_CACHE_SIZE'),
    TEMPORAL_STICKY_TTL_MS: readEnvValue(env, 'TEMPORAL_STICKY_TTL_MS'),
    TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS: readEnvValue(env, 'TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS'),
    TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS: readEnvValue(env, 'TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS'),
    TEMPORAL_WORKER_DEPLOYMENT_NAME: readEnvValue(env, 'TEMPORAL_WORKER_DEPLOYMENT_NAME'),
    TEMPORAL_WORKER_BUILD_ID: readEnvValue(env, 'TEMPORAL_WORKER_BUILD_ID'),
  }
}

const sanitizeGrafEnvironment = (env: NodeJS.ProcessEnv): GrafEnvironment => ({
  GRAF_SERVICE_URL: readEnvValue(env, 'GRAF_SERVICE_URL'),
  GRAF_API_KEY: readEnvValue(env, 'GRAF_API_KEY'),
  GRAF_AUTH_HEADERS: readEnvValue(env, 'GRAF_AUTH_HEADERS'),
  SUPPLY_CHAIN_ARTIFACT_CONFIDENCE_THRESHOLD: readEnvValue(env, 'SUPPLY_CHAIN_ARTIFACT_CONFIDENCE_THRESHOLD'),
  GRAF_REQUEST_TIMEOUT_MS: readEnvValue(env, 'GRAF_REQUEST_TIMEOUT_MS'),
  GRAF_RETRY_MAX_ATTEMPTS: readEnvValue(env, 'GRAF_RETRY_MAX_ATTEMPTS'),
  GRAF_RETRY_INITIAL_DELAY_MS: readEnvValue(env, 'GRAF_RETRY_INITIAL_DELAY_MS'),
  GRAF_RETRY_MAX_DELAY_MS: readEnvValue(env, 'GRAF_RETRY_MAX_DELAY_MS'),
  GRAF_RETRY_BACKOFF_COEFFICIENT: readEnvValue(env, 'GRAF_RETRY_BACKOFF_COEFFICIENT'),
  GRAF_RETRYABLE_STATUS_CODES: readEnvValue(env, 'GRAF_RETRYABLE_STATUS_CODES'),
})

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

const parsePositiveInt = (raw: string | undefined, fallback: number, context: string): number => {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${context}: ${raw}`)
  }
  return parsed
}

const parseNonNegativeInt = (raw: string | undefined, fallback: number, context: string): number => {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${context}: ${raw}`)
  }
  return parsed
}

export interface GrafRetryPolicy {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly backoffCoefficient: number
  readonly retryableStatusCodes: number[]
}

export interface GrafConfig {
  readonly serviceUrl: string
  readonly headers: Record<string, string>
  readonly confidenceThreshold: number
  readonly requestTimeoutMs: number
  readonly retryPolicy: GrafRetryPolicy
}

export interface LoadGrafConfigOptions {
  env?: NodeJS.ProcessEnv
  defaults?: Partial<GrafConfig> & {
    apiKey?: string
    metadataHeaders?: string
  }
}

const parseGrafServiceUrl = (raw: string | undefined, fallback: string): string => {
  const candidate = raw?.trim() ?? fallback.trim()
  if (candidate.length === 0) {
    throw new Error('GRAF_SERVICE_URL cannot be empty')
  }
  return candidate
}

const parseFloatInRange = (
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  context: string,
): number => {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${context}: ${raw}`)
  }
  return parsed
}

const parsePositiveFloat = (raw: string | undefined, fallback: number, context: string): number => {
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${context}: ${raw}`)
  }
  return parsed
}

const parseRetryableStatusCodes = (raw: string | undefined, fallback: number[]): number[] => {
  if (!raw) {
    return fallback
  }
  const segments = raw
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return fallback
  }
  return segments.map((segment) => {
    const parsed = Number.parseInt(segment, 10)
    if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
      throw new Error(`Invalid HTTP status code in GRAF_RETRYABLE_STATUS_CODES: ${segment}`)
    }
    return parsed
  })
}

const parseGrafMetadataHeaders = (raw: string): Record<string, unknown> => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new Error('GRAF_AUTH_HEADERS must describe at least one header')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('GRAF_AUTH_HEADERS must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GRAF_AUTH_HEADERS must be a JSON object')
  }

  const convertValue = (value: unknown): string => {
    if (typeof value === 'string') {
      return value
    }
    if (value === null || value === undefined) {
      return ''
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      return String(value)
    }
    return JSON.stringify(value)
  }

  const headers: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const converted = convertValue(value).trim()
    if (converted.length === 0) {
      continue
    }
    headers[key] = converted
  }

  return headers
}

const buildGrafHeaders = (
  env: GrafEnvironment,
  defaults?: LoadGrafConfigOptions['defaults'],
): Record<string, string> => {
  const baseHeaders = defaults?.headers ?? {}
  const apiKey = env.GRAF_API_KEY ?? defaults?.apiKey
  let headers = mergeHeaders(baseHeaders, createDefaultHeaders(apiKey))
  const metadataSource = env.GRAF_AUTH_HEADERS ?? defaults?.metadataHeaders
  if (metadataSource) {
    headers = mergeHeaders(headers, normalizeMetadataHeaders(parseGrafMetadataHeaders(metadataSource)))
  }
  return headers
}

const buildGrafRetryPolicy = (env: GrafEnvironment, defaults?: LoadGrafConfigOptions['defaults']): GrafRetryPolicy => {
  const retryDefaults = defaults?.retryPolicy
  const maxAttempts = parsePositiveInt(
    env.GRAF_RETRY_MAX_ATTEMPTS,
    retryDefaults?.maxAttempts ?? DEFAULT_GRAF_RETRY_MAX_ATTEMPTS,
    'GRAF_RETRY_MAX_ATTEMPTS',
  )
  const initialDelayMs = parsePositiveInt(
    env.GRAF_RETRY_INITIAL_DELAY_MS,
    retryDefaults?.initialDelayMs ?? DEFAULT_GRAF_RETRY_INITIAL_DELAY_MS,
    'GRAF_RETRY_INITIAL_DELAY_MS',
  )
  const maxDelayMs = parsePositiveInt(
    env.GRAF_RETRY_MAX_DELAY_MS,
    retryDefaults?.maxDelayMs ?? DEFAULT_GRAF_RETRY_MAX_DELAY_MS,
    'GRAF_RETRY_MAX_DELAY_MS',
  )
  const backoffCoefficient = parsePositiveFloat(
    env.GRAF_RETRY_BACKOFF_COEFFICIENT,
    retryDefaults?.backoffCoefficient ?? DEFAULT_GRAF_RETRY_BACKOFF_COEFFICIENT,
    'GRAF_RETRY_BACKOFF_COEFFICIENT',
  )
  const retryableStatusCodes = parseRetryableStatusCodes(
    env.GRAF_RETRYABLE_STATUS_CODES,
    retryDefaults?.retryableStatusCodes ?? DEFAULT_GRAF_RETRYABLE_STATUS_CODES,
  )

  if (maxDelayMs < initialDelayMs) {
    throw new Error('GRAF_RETRY_MAX_DELAY_MS must be >= GRAF_RETRY_INITIAL_DELAY_MS')
  }

  return {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffCoefficient,
    retryableStatusCodes,
  }
}

export const loadGrafConfig = (options: LoadGrafConfigOptions = {}): GrafConfig => {
  const env = sanitizeGrafEnvironment(options.env ?? process.env)
  const defaults = options.defaults
  const serviceUrl = parseGrafServiceUrl(env.GRAF_SERVICE_URL, defaults?.serviceUrl ?? DEFAULT_GRAF_SERVICE_URL)
  const confidenceThreshold = parseFloatInRange(
    env.SUPPLY_CHAIN_ARTIFACT_CONFIDENCE_THRESHOLD,
    defaults?.confidenceThreshold ?? DEFAULT_SUPPLY_CHAIN_ARTIFACT_CONFIDENCE_THRESHOLD,
    0,
    1,
    'SUPPLY_CHAIN_ARTIFACT_CONFIDENCE_THRESHOLD',
  )
  const requestTimeoutMs = parsePositiveInt(
    env.GRAF_REQUEST_TIMEOUT_MS,
    defaults?.requestTimeoutMs ?? DEFAULT_GRAF_REQUEST_TIMEOUT_MS,
    'GRAF_REQUEST_TIMEOUT_MS',
  )

  return {
    serviceUrl,
    headers: buildGrafHeaders(env, defaults),
    confidenceThreshold,
    requestTimeoutMs,
    retryPolicy: buildGrafRetryPolicy(env, defaults),
  }
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
  workerWorkflowConcurrency: number
  workerActivityConcurrency: number
  workerStickyCacheSize: number
  workerStickyTtlMs: number
  activityHeartbeatIntervalMs: number
  activityHeartbeatRpcTimeoutMs: number
  workerDeploymentName?: string
  workerBuildId?: string
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
  const fallbackWorkflowConcurrency = options.defaults?.workerWorkflowConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY
  const fallbackActivityConcurrency = options.defaults?.workerActivityConcurrency ?? DEFAULT_ACTIVITY_CONCURRENCY
  const fallbackStickyCacheSize = options.defaults?.workerStickyCacheSize ?? DEFAULT_STICKY_CACHE_SIZE
  const fallbackStickyTtl = options.defaults?.workerStickyTtlMs ?? DEFAULT_STICKY_CACHE_TTL_MS
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
  const workerStickyTtlMs = parseNonNegativeInt(env.TEMPORAL_STICKY_TTL_MS, fallbackStickyTtl, 'TEMPORAL_STICKY_TTL_MS')
  const fallbackHeartbeatInterval =
    options.defaults?.activityHeartbeatIntervalMs ?? DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS
  const fallbackHeartbeatRpcTimeout =
    options.defaults?.activityHeartbeatRpcTimeoutMs ?? DEFAULT_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS
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
  const workerDeploymentName = env.TEMPORAL_WORKER_DEPLOYMENT_NAME ?? options.defaults?.workerDeploymentName
  const workerBuildId = env.TEMPORAL_WORKER_BUILD_ID ?? options.defaults?.workerBuildId
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
    workerWorkflowConcurrency,
    workerActivityConcurrency,
    workerStickyCacheSize,
    workerStickyTtlMs,
    activityHeartbeatIntervalMs,
    activityHeartbeatRpcTimeoutMs,
    workerDeploymentName,
    workerBuildId,
  }
}

export const temporalDefaults = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  namespace: DEFAULT_NAMESPACE,
  taskQueue: DEFAULT_TASK_QUEUE,
  workerIdentityPrefix: DEFAULT_IDENTITY_PREFIX,
  workerWorkflowConcurrency: DEFAULT_WORKFLOW_CONCURRENCY,
  workerActivityConcurrency: DEFAULT_ACTIVITY_CONCURRENCY,
  workerStickyCacheSize: DEFAULT_STICKY_CACHE_SIZE,
  workerStickyTtlMs: DEFAULT_STICKY_CACHE_TTL_MS,
  activityHeartbeatIntervalMs: DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS,
  activityHeartbeatRpcTimeoutMs: DEFAULT_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS,
  workerDeploymentName: undefined,
  workerBuildId: undefined,
} satisfies Pick<
  TemporalConfig,
  | 'host'
  | 'port'
  | 'namespace'
  | 'taskQueue'
  | 'workerIdentityPrefix'
  | 'workerWorkflowConcurrency'
  | 'workerActivityConcurrency'
  | 'workerStickyCacheSize'
  | 'workerStickyTtlMs'
  | 'activityHeartbeatIntervalMs'
  | 'activityHeartbeatRpcTimeoutMs'
  | 'workerDeploymentName'
  | 'workerBuildId'
>
