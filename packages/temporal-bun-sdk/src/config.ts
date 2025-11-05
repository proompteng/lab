import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 7233
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_TASK_QUEUE = 'prix'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-worker'

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
  workflowContextBypass: boolean
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
  }
}

export const temporalDefaults = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  namespace: DEFAULT_NAMESPACE,
  taskQueue: DEFAULT_TASK_QUEUE,
  workerIdentityPrefix: DEFAULT_IDENTITY_PREFIX,
  workflowContextBypass: false,
} satisfies Pick<
  TemporalConfig,
  'host' | 'port' | 'namespace' | 'taskQueue' | 'workerIdentityPrefix' | 'workflowContextBypass'
>
