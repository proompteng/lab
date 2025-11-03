import { readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { status as GrpcStatus, Metadata } from '@grpc/grpc-js'
import { Connection, type ConnectionOptions, isGrpcServiceError } from '@temporalio/client'
import * as defaultActivities from './activities'
import type { DataConverter } from './common/payloads'
import { loadTemporalConfig, type TemporalConfig } from './config'
import { NativeBridgeError } from './internal/core-bridge/native'
import {
  getZigWorkerBridgeDiagnostics,
  isZigWorkerBridgeEnabled,
  WorkerRuntime,
  type WorkerRuntimeOptions,
} from './worker/runtime'

const DEFAULT_WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.js', import.meta.url))
const PACKAGE_NAME = '@proompteng/temporal-bun-sdk'

let cachedBuildId: string | null = null
let buildIdLogged = false
let connectionFactory: (options: ConnectionOptions) => Promise<Connection> = async (options) =>
  await Connection.connect(options)
const DEFAULT_VERSIONING_RPC_DEADLINE_MS = 5_000

const deriveBuildId = (): string => {
  if (cachedBuildId) {
    return cachedBuildId
  }

  const envOverride = process.env.TEMPORAL_WORKER_BUILD_ID?.trim()
  if (envOverride) {
    cachedBuildId = envOverride
    return envOverride
  }

  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const payload = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    const version = typeof payload.version === 'string' ? payload.version.trim() : ''
    if (name === PACKAGE_NAME && version.length > 0) {
      const candidate = `${name}@${version}`
      cachedBuildId = candidate
      return candidate
    }
  } catch {
    // ignore and fall back to hostname-based build ID
  }

  const fallback = `${os.hostname()}-${process.pid}@dev`
  cachedBuildId = fallback
  return fallback
}

type ActivityHandler = (...args: unknown[]) => unknown
type ActivitiesMap = Record<string, ActivityHandler>
type ActivitiesInput = ActivitiesMap | ActivitiesMap[]
type WorkflowsPathInput = string | URL | Array<string | URL>

export interface CreateWorkerOptions {
  config?: TemporalConfig
  taskQueue?: string
  workflowsPath?: WorkflowsPathInput
  activities?: ActivitiesInput
  dataConverter?: DataConverter
}

export interface BunWorkerHandle {
  worker: BunWorker
  runtime: WorkerRuntime
  config: TemporalConfig
}

export class BunWorker {
  constructor(private readonly runtime: WorkerRuntime) {}

  async run(): Promise<void> {
    await this.runtime.run()
  }

  async shutdown(gracefulTimeoutMs?: number): Promise<void> {
    await this.runtime.shutdown(gracefulTimeoutMs)
  }
}

const BRIDGE_UNAVAILABLE_MESSAGE =
  'The Bun worker runtime requires TEMPORAL_BUN_SDK_USE_ZIG=1 and the compiled Zig bridge. Run `pnpm --filter @proompteng/temporal-bun-sdk run build:native` on this host before starting the worker.'

const throwMissingZigBridge = (): never => {
  const diagnostics = getZigWorkerBridgeDiagnostics()
  console.error(`[temporal-bun-sdk] ${BRIDGE_UNAVAILABLE_MESSAGE}`, diagnostics)
  throw new NativeBridgeError({
    code: 2,
    message: BRIDGE_UNAVAILABLE_MESSAGE,
    details: diagnostics,
  })
}

export const createWorker = async (options: CreateWorkerOptions = {}): Promise<BunWorkerHandle> => {
  if (!isZigWorkerBridgeEnabled()) {
    throwMissingZigBridge()
  }

  const config = options.config ?? (await loadTemporalConfig())
  if (config.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  const taskQueue = options.taskQueue ?? config.taskQueue
  if (!taskQueue) {
    throw new NativeBridgeError({
      code: 3,
      message: 'A task queue must be provided to start the Bun worker runtime.',
    })
  }

  const workflowsPath = resolveWorkflowsPath(options.workflowsPath)
  const activities = resolveActivities(options.activities)
  const buildId = deriveBuildId()

  await ensureBuildIdVersioningRule(config, taskQueue, buildId)

  if (!buildIdLogged) {
    buildIdLogged = true
    console.info('[temporal-bun-sdk] worker buildId: %s', buildId)
  }

  const runtimeOptions: WorkerRuntimeOptions = {
    workflowsPath,
    activities,
    taskQueue,
    namespace: config.namespace,
    dataConverter: options.dataConverter,
    buildId,
  }

  const runtime = await WorkerRuntime.create(runtimeOptions)
  const worker = new BunWorker(runtime)

  return { worker, runtime, config }
}

export const runWorker = async (options?: CreateWorkerOptions) => {
  const { worker } = await createWorker(options)
  await worker.run()
  return worker
}

const resolveActivities = (activities: CreateWorkerOptions['activities']): ActivitiesMap => {
  if (!activities) {
    return defaultActivities
  }
  if (Array.isArray(activities)) {
    const [first] = activities
    return (first as ActivitiesMap | undefined) ?? defaultActivities
  }
  return activities
}

const resolveWorkflowsPath = (input: CreateWorkerOptions['workflowsPath']): string => {
  if (input === undefined || input === null) {
    return DEFAULT_WORKFLOWS_PATH
  }
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return fileURLToPath(input)
  }
  if (Array.isArray(input) && input.length > 0) {
    const [first] = input
    if (typeof first === 'string') {
      return first
    }
    if (first instanceof URL) {
      return fileURLToPath(first)
    }
  }
  throw new Error('workflowsPath must resolve to a string path when using the Bun worker runtime')
}

async function ensureBuildIdVersioningRule(config: TemporalConfig, taskQueue: string, buildId: string): Promise<void> {
  let connection: Connection | null = null
  try {
    const connectionOptions: ConnectionOptions = {
      address: config.address,
      apiKey: config.apiKey,
      tls: resolveTlsOptions(config),
    }

    connection = await connectionFactory(connectionOptions)

    const workflowService = connection.workflowService

    const capabilities = await connection
      .withDeadline(DEFAULT_VERSIONING_RPC_DEADLINE_MS, async () => workflowService.getSystemInfo({}))
      .then((response) => response.capabilities)

    if (!capabilities?.buildIdBasedVersioning) {
      if (process.env.TEMPORAL_BUN_LOG_LEVEL === 'debug') {
        console.debug('[temporal-bun-sdk] buildId preflight skipped; worker versioning not enabled on server')
      }
      await ensureBuildIdCompatibilityLegacy(connection, workflowService, config, taskQueue, buildId)
      return
    }

    const rules = await connection.withDeadline(DEFAULT_VERSIONING_RPC_DEADLINE_MS, async () =>
      workflowService.getWorkerVersioningRules({
        namespace: config.namespace,
        taskQueue,
      }),
    )

    const assignmentRules = rules.assignmentRules ?? []
    const hasFullCoverageRule = assignmentRules.some((entry) => {
      const rule = entry?.rule
      if (!rule) {
        return false
      }
      if (rule.targetBuildId !== buildId) {
        return false
      }
      return rule.percentageRamp == null
    })

    if (hasFullCoverageRule) {
      return
    }

    await connection.withDeadline(DEFAULT_VERSIONING_RPC_DEADLINE_MS, async () =>
      workflowService.updateWorkerVersioningRules({
        namespace: config.namespace,
        taskQueue,
        conflictToken: rules.conflictToken ?? undefined,
        commitBuildId: {
          targetBuildId: buildId,
          force: true,
        },
      }),
    )
  } catch (error) {
    if (shouldFallbackToCompatibilityForError(error)) {
      console.warn('[temporal-bun-sdk] worker versioning rules unavailable; falling back to compatibility API', error)
      await ensureBuildIdCompatibilityLegacy(connection, connection?.workflowService, config, taskQueue, buildId)
      return
    }
    if (shouldIgnoreVersioningError(error)) {
      console.warn('[temporal-bun-sdk] skipping worker buildId preflight:', error)
      return
    }

    throw new NativeBridgeError({
      code: 2,
      message: 'Failed to ensure worker buildId versioning rules before startup.',
      details: normalizeErrorDetails(error),
    })
  } finally {
    await connection?.close()
  }
}

async function ensureBuildIdCompatibilityLegacy(
  connection: Connection | null,
  workflowService: Connection['workflowService'] | undefined,
  config: TemporalConfig,
  taskQueue: string,
  buildId: string,
): Promise<void> {
  if (!connection || !workflowService) {
    return
  }

  const requestBase = {
    namespace: config.namespace,
    taskQueue,
  }

  const fetchCompatibility = async () =>
    connection
      .withDeadline(DEFAULT_VERSIONING_RPC_DEADLINE_MS, async () =>
        workflowService.getWorkerBuildIdCompatibility(requestBase),
      )
      .catch((error) => {
        if (isWorkerVersioningDisabledError(error)) {
          return null
        }
        throw error
      })

  let compatibility = await fetchCompatibility()
  if (!compatibility) {
    return
  }

  if (containsBuildId(compatibility, buildId)) {
    return
  }

  try {
    await connection.withDeadline(DEFAULT_VERSIONING_RPC_DEADLINE_MS, async () =>
      workflowService.updateWorkerBuildIdCompatibility({
        ...requestBase,
        addNewBuildIdInNewDefaultSet: buildId,
      }),
    )
  } catch (error) {
    if (isWorkerVersioningDisabledError(error)) {
      return
    }
    if (!isAlreadyExistsError(error)) {
      throw error
    }
  }

  compatibility = await fetchCompatibility()
  if (!compatibility) {
    return
  }

  if (!containsBuildId(compatibility, buildId)) {
    throw new NativeBridgeError({
      code: 2,
      message: 'buildId not present in compatibility rules after update',
      details: { taskQueue, buildId },
    })
  }
}

export const __testing = {
  BRIDGE_UNAVAILABLE_MESSAGE,
  setConnectionFactory(factory: (options: ConnectionOptions) => Promise<Connection>) {
    connectionFactory = factory
  },
  resetConnectionFactory() {
    connectionFactory = async (options) => await Connection.connect(options)
  },
  ensureBuildIdVersioningRule,
}

const resolveTlsOptions = (config: TemporalConfig): ConnectionOptions['tls'] => {
  const tlsConfig = config.tls
  if (tlsConfig) {
    return {
      serverRootCACertificate: tlsConfig.serverRootCACertificate,
      clientCertPair: tlsConfig.clientCertPair
        ? {
            crt: tlsConfig.clientCertPair.crt,
            key: tlsConfig.clientCertPair.key,
          }
        : undefined,
      serverNameOverride: tlsConfig.serverNameOverride,
    }
  }
  if (config.allowInsecureTls) {
    return false
  }
  return undefined
}

const shouldIgnoreVersioningError = (error: unknown): boolean => {
  if (shouldFallbackToCompatibilityForError(error)) {
    return true
  }
  if (!isGrpcServiceError(error)) {
    return false
  }
  if (error.code === GrpcStatus.UNIMPLEMENTED || error.code === GrpcStatus.DEADLINE_EXCEEDED) {
    return true
  }
  return false
}

const containsBuildId = (
  compatibility: {
    majorVersionSets?: Array<{ buildIds?: Array<{ buildId?: string | null } | null> | null }>
  },
  buildId: string,
): boolean => {
  const sets = compatibility.majorVersionSets ?? []
  for (const set of sets) {
    const versions = set?.buildIds ?? []
    for (const version of versions) {
      if (version?.buildId === buildId) {
        return true
      }
    }
  }
  return false
}

const isAlreadyExistsError = (error: unknown): boolean => {
  if (!isGrpcServiceError(error)) {
    return false
  }
  if (error.code === GrpcStatus.ALREADY_EXISTS) {
    return true
  }
  const details = (error.details ?? error.message ?? '').toUpperCase()
  return details.includes('ALREADY_EXISTS')
}

const isWorkerVersioningDisabledError = (error: unknown): boolean => {
  if (!isGrpcServiceError(error)) {
    return false
  }
  if (
    error.code !== GrpcStatus.FAILED_PRECONDITION &&
    error.code !== GrpcStatus.PERMISSION_DENIED &&
    error.code !== GrpcStatus.DEADLINE_EXCEEDED
  ) {
    return false
  }
  const details = (error.details ?? error.message ?? '').toUpperCase()
  return details.includes('WORKER VERSIONING') && details.includes('DISABLED')
}

const shouldFallbackToCompatibilityForError = (error: unknown): boolean => {
  if (isWorkerVersioningDisabledError(error)) {
    return true
  }
  const code = (error as { code?: unknown })?.code
  if (code === GrpcStatus.UNIMPLEMENTED || code === 'UNIMPLEMENTED') {
    return true
  }
  return false
}

const normalizeErrorDetails = (error: unknown): Record<string, unknown> => {
  if (!error || typeof error !== 'object') {
    return { error: String(error) }
  }

  const payload: Record<string, unknown> = {
    message: error instanceof Error ? error.message : String(error),
  }

  if (isGrpcServiceError(error)) {
    payload.code = error.code
    payload.details = error.details
    if (error.metadata instanceof Metadata) {
      payload.metadata = error.metadata.getMap()
    }
  }

  if ('stack' in error && typeof error.stack === 'string') {
    payload.stack = error.stack
  }

  return payload
}
