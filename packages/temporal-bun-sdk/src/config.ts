import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'

import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 7233
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_TASK_QUEUE = 'prix'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-worker'
const DEFAULT_WORKFLOW_CONCURRENCY = 4
const DEFAULT_ACTIVITY_CONCURRENCY = 4
const DEFAULT_STICKY_CACHE_SIZE = 128
const DEFAULT_STICKY_CACHE_TTL_MS = 5 * 60_000

const truthyValues = new Set(['1', 'true', 't', 'yes', 'y', 'on'])
const falsyValues = new Set(['0', 'false', 'f', 'no', 'n', 'off'])

const NonEmptyString = Schema.String.pipe(Schema.trimmed(), Schema.nonEmptyString())
const OptionalNonEmptyString = Schema.optional(NonEmptyString)
const PortSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1), Schema.lessThanOrEqualTo(65_535))
const PositiveIntSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))
const NonNegativeIntSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))
const BufferSchema = Schema.instanceOf(Buffer)

const TLSCertPairStruct = Schema.Struct({
  crt: BufferSchema,
  key: BufferSchema,
})
const TLSConfigStruct = Schema.Struct({
  serverRootCACertificate: Schema.optional(BufferSchema),
  serverNameOverride: OptionalNonEmptyString,
  clientCertPair: Schema.optional(TLSCertPairStruct),
})
const TemporalConfigStruct = Schema.Struct({
  host: NonEmptyString,
  port: PortSchema,
  address: NonEmptyString,
  namespace: NonEmptyString,
  taskQueue: NonEmptyString,
  apiKey: OptionalNonEmptyString,
  tls: Schema.optional(TLSConfigStruct),
  allowInsecureTls: Schema.Boolean,
  workerIdentity: NonEmptyString,
  workerIdentityPrefix: NonEmptyString,
  showStackTraceSources: Schema.Boolean,
  workflowContextBypass: Schema.Boolean,
  workerWorkflowConcurrency: PositiveIntSchema,
  workerActivityConcurrency: PositiveIntSchema,
  workerStickyCacheSize: NonNegativeIntSchema,
  workerStickyTtlMs: NonNegativeIntSchema,
  workerDeploymentName: OptionalNonEmptyString,
  workerBuildId: OptionalNonEmptyString,
})

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export type TLSCertPair = Mutable<Schema.Schema.Type<typeof TLSCertPairStruct>>
export type TLSConfig = Mutable<Schema.Schema.Type<typeof TLSConfigStruct>>
export type TemporalConfig = Mutable<Schema.Schema.Type<typeof TemporalConfigStruct>>
export const TemporalConfigSchema = TemporalConfigStruct

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
  TEMPORAL_WORKFLOW_CONCURRENCY?: string
  TEMPORAL_ACTIVITY_CONCURRENCY?: string
  TEMPORAL_STICKY_CACHE_SIZE?: string
  TEMPORAL_STICKY_TTL_MS?: string
  TEMPORAL_WORKER_DEPLOYMENT_NAME?: string
  TEMPORAL_WORKER_BUILD_ID?: string
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
    TEMPORAL_WORKER_IDENTITY_PREFIX: read('TEMPORAL_WORKER_IDENTITY_PREFIX'),
    TEMPORAL_SHOW_STACK_SOURCES: read('TEMPORAL_SHOW_STACK_SOURCES'),
    TEMPORAL_DISABLE_WORKFLOW_CONTEXT: read('TEMPORAL_DISABLE_WORKFLOW_CONTEXT'),
    TEMPORAL_WORKFLOW_CONCURRENCY: read('TEMPORAL_WORKFLOW_CONCURRENCY'),
    TEMPORAL_ACTIVITY_CONCURRENCY: read('TEMPORAL_ACTIVITY_CONCURRENCY'),
    TEMPORAL_STICKY_CACHE_SIZE: read('TEMPORAL_STICKY_CACHE_SIZE'),
    TEMPORAL_STICKY_TTL_MS: read('TEMPORAL_STICKY_TTL_MS'),
    TEMPORAL_WORKER_DEPLOYMENT_NAME: read('TEMPORAL_WORKER_DEPLOYMENT_NAME'),
    TEMPORAL_WORKER_BUILD_ID: read('TEMPORAL_WORKER_BUILD_ID'),
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

export interface LoadTemporalConfigOptions {
  env?: NodeJS.ProcessEnv
  fs?: {
    readFile?: typeof readFile
  }
  defaults?: Partial<TemporalConfig>
}

export class TemporalConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TemporalConfigError'
  }
}

const decodeTemporalConfig = Schema.decodeUnknown(TemporalConfigSchema)

const toTemporalConfigError = (cause: unknown): TemporalConfigError => {
  if (cause instanceof TemporalConfigError) {
    return cause
  }
  const message = cause instanceof Error ? cause.message : `Temporal configuration error: ${String(cause)}`
  return new TemporalConfigError(message, { cause })
}

const tryConfig = <A>(fn: () => A) =>
  Effect.try({
    try: fn,
    catch: toTemporalConfigError,
  })

const cloneTlsConfig = (input?: TLSConfig): TLSConfig | undefined => {
  if (!input) return undefined
  return {
    serverRootCACertificate: input.serverRootCACertificate,
    serverNameOverride: input.serverNameOverride,
    clientCertPair: input.clientCertPair
      ? {
          crt: input.clientCertPair.crt,
          key: input.clientCertPair.key,
        }
      : undefined,
  }
}

const buildTlsConfigEffect = (
  env: TemporalEnvironment,
  options: LoadTemporalConfigOptions,
): Effect.Effect<TLSConfig | undefined, TemporalConfigError> =>
  Effect.gen(function* () {
    const caPath = env.TEMPORAL_TLS_CA_PATH
    const certPath = env.TEMPORAL_TLS_CERT_PATH
    const keyPath = env.TEMPORAL_TLS_KEY_PATH
    const serverName = env.TEMPORAL_TLS_SERVER_NAME

    if (!caPath && !certPath && !keyPath && !serverName) {
      return cloneTlsConfig(options.defaults?.tls)
    }

    if ((certPath && !keyPath) || (!certPath && keyPath)) {
      yield* Effect.fail(
        new TemporalConfigError('Both TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH must be provided for mTLS'),
      )
    }

    const reader = options.fs?.readFile ?? readFile
    const tls: TLSConfig = cloneTlsConfig(options.defaults?.tls) ?? {}

    if (caPath) {
      tls.serverRootCACertificate = yield* Effect.tryPromise({
        try: () => reader(caPath),
        catch: (cause) => new TemporalConfigError(`Failed to read TEMPORAL_TLS_CA_PATH at ${caPath}`, { cause }),
      })
    }

    if (certPath && keyPath) {
      tls.clientCertPair = {
        crt: yield* Effect.tryPromise({
          try: () => reader(certPath),
          catch: (cause) => new TemporalConfigError(`Failed to read TEMPORAL_TLS_CERT_PATH at ${certPath}`, { cause }),
        }),
        key: yield* Effect.tryPromise({
          try: () => reader(keyPath),
          catch: (cause) => new TemporalConfigError(`Failed to read TEMPORAL_TLS_KEY_PATH at ${keyPath}`, { cause }),
        }),
      }
    }

    if (serverName) {
      tls.serverNameOverride = serverName
    }

    return tls
  })

export const loadTemporalConfigEffect = (
  options: LoadTemporalConfigOptions = {},
): Effect.Effect<TemporalConfig, TemporalConfigError, never> =>
  Effect.gen(function* () {
    const env = sanitizeEnvironment(options.env ?? process.env)
    const port = yield* tryConfig(() => parsePort(env.TEMPORAL_GRPC_PORT))
    const host = env.TEMPORAL_HOST ?? options.defaults?.host ?? DEFAULT_HOST
    const address = env.TEMPORAL_ADDRESS ?? options.defaults?.address ?? `${host}:${port}`
    const namespace = env.TEMPORAL_NAMESPACE ?? options.defaults?.namespace ?? DEFAULT_NAMESPACE
    const taskQueue = env.TEMPORAL_TASK_QUEUE ?? options.defaults?.taskQueue ?? DEFAULT_TASK_QUEUE
    const fallbackWorkflowConcurrency = options.defaults?.workerWorkflowConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY
    const fallbackActivityConcurrency = options.defaults?.workerActivityConcurrency ?? DEFAULT_ACTIVITY_CONCURRENCY
    const fallbackStickyCacheSize = options.defaults?.workerStickyCacheSize ?? DEFAULT_STICKY_CACHE_SIZE
    const fallbackStickyTtl = options.defaults?.workerStickyTtlMs ?? DEFAULT_STICKY_CACHE_TTL_MS

    const workerWorkflowConcurrency = yield* tryConfig(() =>
      parsePositiveInt(env.TEMPORAL_WORKFLOW_CONCURRENCY, fallbackWorkflowConcurrency, 'TEMPORAL_WORKFLOW_CONCURRENCY'),
    )
    const workerActivityConcurrency = yield* tryConfig(() =>
      parsePositiveInt(env.TEMPORAL_ACTIVITY_CONCURRENCY, fallbackActivityConcurrency, 'TEMPORAL_ACTIVITY_CONCURRENCY'),
    )
    const workerStickyCacheSize = yield* tryConfig(() =>
      parseNonNegativeInt(env.TEMPORAL_STICKY_CACHE_SIZE, fallbackStickyCacheSize, 'TEMPORAL_STICKY_CACHE_SIZE'),
    )
    const workerStickyTtlMs = yield* tryConfig(() =>
      parseNonNegativeInt(env.TEMPORAL_STICKY_TTL_MS, fallbackStickyTtl, 'TEMPORAL_STICKY_TTL_MS'),
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
    const tls = yield* buildTlsConfigEffect(env, options)
    const showStackTraceSources =
      coerceBoolean(env.TEMPORAL_SHOW_STACK_SOURCES) ?? options.defaults?.showStackTraceSources ?? false
    const workflowContextBypass =
      coerceBoolean(env.TEMPORAL_DISABLE_WORKFLOW_CONTEXT) ?? options.defaults?.workflowContextBypass ?? false

    const configCandidate = {
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
      workerWorkflowConcurrency,
      workerActivityConcurrency,
      workerStickyCacheSize,
      workerStickyTtlMs,
      workerDeploymentName,
      workerBuildId,
    }

    const decoded = yield* decodeTemporalConfig(configCandidate).pipe(
      Effect.mapError((error) => new TemporalConfigError('Temporal configuration validation failed', { cause: error })),
    )

    return decoded
  })

export const loadTemporalConfig = async (options: LoadTemporalConfigOptions = {}): Promise<TemporalConfig> => {
  // TODO(TBS-010): Remove legacy promise helper once all entry points consume the Effect layer.
  return await Effect.runPromise(loadTemporalConfigEffect(options))
}

export const temporalDefaults = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  namespace: DEFAULT_NAMESPACE,
  taskQueue: DEFAULT_TASK_QUEUE,
  workerIdentityPrefix: DEFAULT_IDENTITY_PREFIX,
  workflowContextBypass: false,
  workerWorkflowConcurrency: DEFAULT_WORKFLOW_CONCURRENCY,
  workerActivityConcurrency: DEFAULT_ACTIVITY_CONCURRENCY,
  workerStickyCacheSize: DEFAULT_STICKY_CACHE_SIZE,
  workerStickyTtlMs: DEFAULT_STICKY_CACHE_TTL_MS,
  workerDeploymentName: undefined,
  workerBuildId: undefined,
} satisfies Pick<
  TemporalConfig,
  | 'host'
  | 'port'
  | 'namespace'
  | 'taskQueue'
  | 'workerIdentityPrefix'
  | 'workflowContextBypass'
  | 'workerWorkflowConcurrency'
  | 'workerActivityConcurrency'
  | 'workerStickyCacheSize'
  | 'workerStickyTtlMs'
  | 'workerDeploymentName'
  | 'workerBuildId'
>
