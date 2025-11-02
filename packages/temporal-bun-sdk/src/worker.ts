import { readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import type { NativeConnection, NativeConnectionOptions, WorkerOptions } from '@temporalio/worker'

import * as defaultActivities from './activities'
import type { DataConverter } from './common/payloads'
import { loadTemporalConfig, type TemporalConfig } from './config'
import { NativeBridgeError } from './internal/core-bridge/native'
import { isZigWorkerBridgeEnabled, WorkerRuntime, type WorkerRuntimeOptions } from './worker/runtime'

const DEFAULT_WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.js', import.meta.url))
const VENDOR_FALLBACK_ENV = 'TEMPORAL_BUN_SDK_VENDOR_FALLBACK'
const PACKAGE_NAME = '@proompteng/temporal-bun-sdk'

let cachedBuildId: string | null = null
let buildIdLogged = false

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

export type WorkerOptionOverrides = Omit<WorkerOptions, 'connection' | 'taskQueue' | 'workflowsPath' | 'activities'>

export interface CreateWorkerOptions {
  config?: TemporalConfig
  connection?: NativeConnection
  taskQueue?: string
  workflowsPath?: WorkerOptions['workflowsPath']
  activities?: WorkerOptions['activities']
  workerOptions?: WorkerOptionOverrides
  nativeConnectionOptions?: NativeConnectionOptions
  dataConverter?: DataConverter
}

export interface BunWorkerHandle {
  worker: BunWorker
  runtime: WorkerRuntime
  config: TemporalConfig
  connection: null
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

export const createWorker = async (
  options: CreateWorkerOptions = {},
): Promise<BunWorkerHandle | VendorWorkerHandle> => {
  if (!isZigWorkerBridgeEnabled()) {
    if (process.env[VENDOR_FALLBACK_ENV] === '1') {
      return await createVendorWorker(options)
    }
    throw new NativeBridgeError({
      code: 2,
      message:
        'The Bun-native worker runtime requires TEMPORAL_BUN_SDK_USE_ZIG=1 and the Zig bridge. Set TEMPORAL_BUN_SDK_VENDOR_FALLBACK=1 to opt into the legacy @temporalio/worker implementation.',
      details: { bridgeVariant: 'non-zig' },
    })
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

  return { worker, runtime, config, connection: null }
}

export const runWorker = async (options?: CreateWorkerOptions) => {
  const result = await createWorker(options)
  if ('runtime' in result) {
    await result.worker.run()
    return result.worker
  }
  await result.worker.run()
  return result.worker
}

interface VendorWorkerHandle {
  worker: import('@temporalio/worker').Worker
  config: TemporalConfig
  connection: NativeConnection
}

const createVendorWorker = async (options: CreateWorkerOptions): Promise<VendorWorkerHandle> => {
  const { NativeConnection, Worker } = await import('@temporalio/worker')
  const config = options.config ?? (await loadTemporalConfig())
  if (config.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  const connection =
    options.connection ??
    (await NativeConnection.connect({
      address: config.address,
      ...(config.tls ? { tls: config.tls } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(options.nativeConnectionOptions ?? {}),
    }))

  const taskQueue = options.taskQueue ?? config.taskQueue
  const workflowsPath = options.workflowsPath ?? DEFAULT_WORKFLOWS_PATH
  const activities = options.activities ?? defaultActivities

  const worker = await Worker.create({
    connection,
    taskQueue,
    workflowsPath,
    activities,
    identity: config.workerIdentity,
    namespace: config.namespace,
    ...(options.workerOptions ?? {}),
  })

  return { worker, config, connection }
}

const resolveActivities = (
  activities: CreateWorkerOptions['activities'],
): Record<string, (...args: unknown[]) => unknown> => {
  if (!activities) {
    return defaultActivities
  }
  if (Array.isArray(activities)) {
    return activities[0] ?? defaultActivities
  }
  return activities as Record<string, (...args: unknown[]) => unknown>
}

const resolveWorkflowsPath = (input: CreateWorkerOptions['workflowsPath']): string => {
  if (input === undefined || input === null) {
    return DEFAULT_WORKFLOWS_PATH
  }
  if (typeof input === 'string') {
    return input
  }
  const candidate = input as unknown
  if (Array.isArray(candidate) && candidate.length > 0) {
    const [first] = candidate
    if (typeof first === 'string') {
      return first
    }
  }
  throw new Error('workflowsPath must be a string when using the Bun worker runtime')
}
