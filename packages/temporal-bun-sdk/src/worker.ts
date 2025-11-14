import { readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import * as defaultActivities from './activities'
import type { DataConverter } from './common/payloads'
import { loadTemporalConfig, type TemporalConfig } from './config'
import type { ActivityHandler } from './worker/runtime'
import { WorkerRuntime } from './worker/runtime'
import type { WorkflowDefinitions } from './workflow/definition'

const DEFAULT_WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.js', import.meta.url))
const PACKAGE_NAME = '@proompteng/temporal-bun-sdk'

let cachedBuildId: string | null = null

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
    // fall through and return hostname-based identifier
  }

  const fallback = `${os.hostname()}-${process.pid}@dev`
  cachedBuildId = fallback
  return fallback
}

export interface CreateWorkerOptions {
  config?: TemporalConfig
  taskQueue?: string
  namespace?: string
  workflowsPath?: string
  workflows?: WorkflowDefinitions
  activities?: Record<string, ActivityHandler>
  dataConverter?: DataConverter
  identity?: string
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

  async shutdown(): Promise<void> {
    await this.runtime.shutdown()
  }
}

export const createWorker = async (options: CreateWorkerOptions = {}): Promise<BunWorkerHandle> => {
  const config = options.config ?? (await loadTemporalConfig())
  if (config.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  const taskQueue = options.taskQueue ?? config.taskQueue
  if (!taskQueue) {
    throw new Error('A task queue must be provided to start the Temporal worker runtime.')
  }

  const namespace = options.namespace ?? config.namespace
  if (!namespace) {
    throw new Error('A namespace must be provided to start the Temporal worker runtime.')
  }

  const workflowsPath = resolveWorkflowsPath(options.workflowsPath)
  const activities = resolveActivities(options.activities)
  const derivedBuildId = deriveBuildId()
  const resolvedBuildId = config.workerBuildId ?? derivedBuildId
  if (!config.workerBuildId) {
    config.workerBuildId = resolvedBuildId
  }

  const runtime = await WorkerRuntime.create({
    config,
    workflowsPath,
    workflows: options.workflows,
    activities,
    taskQueue,
    namespace,
    dataConverter: options.dataConverter,
    identity: options.identity,
    deployment: {
      buildId: resolvedBuildId,
    },
  })

  const worker = new BunWorker(runtime)

  return { worker, runtime, config }
}

export const runWorker = async (options?: CreateWorkerOptions) => {
  const result = await createWorker(options)
  await result.worker.run()
  return result.worker
}

const resolveActivities = (activities: CreateWorkerOptions['activities']): Record<string, ActivityHandler> => {
  if (!activities) {
    return defaultActivities
  }
  if (Array.isArray(activities)) {
    return activities[0] ?? defaultActivities
  }
  return activities as Record<string, ActivityHandler>
}

const resolveWorkflowsPath = (input: CreateWorkerOptions['workflowsPath']): string | undefined => {
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
  throw new Error('workflowsPath must be a string when using the Temporal worker runtime')
}
