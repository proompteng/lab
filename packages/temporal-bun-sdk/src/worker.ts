import { fileURLToPath } from 'node:url'
import {
  NativeConnection,
  type NativeConnectionOptions,
  Worker,
  type WorkerOptions,
  bundleWorkflowCode,
} from '@temporalio/worker'
import { loadTemporalConfig, type TemporalConfig } from './config'
import * as defaultActivities from './activities'
import type { BridgeWorker, BridgeWorkerOptions } from './types'

const DEFAULT_WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.js', import.meta.url))

export type WorkerOptionOverrides = Omit<WorkerOptions, 'connection' | 'taskQueue' | 'workflowsPath' | 'activities'>

export interface CreateWorkerOptions {
  config?: TemporalConfig
  connection?: NativeConnection
  taskQueue?: string
  workflowsPath?: WorkerOptions['workflowsPath']
  activities?: WorkerOptions['activities']
  workerOptions?: WorkerOptionOverrides
  nativeConnectionOptions?: NativeConnectionOptions
}

export const createWorker = async (options: CreateWorkerOptions = {}) => {
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

export const runWorker = async (options?: CreateWorkerOptions) => {
  const { worker } = await createWorker(options)
  await worker.run()
  return worker
}

export const createBridgeWorker = async (options: BridgeWorkerOptions): Promise<BridgeWorker> => {
  const connection = await NativeConnection.connect({ address: options.address })
  try {
    const workflowBundle = await bundleWorkflowCode({ workflowsPath: options.workflowsPath })
    const worker = await Worker.create({
      connection,
      namespace: options.namespace,
      taskQueue: options.taskQueue,
      workflowBundle,
      activities: options.activities,
      identity: options.identity ?? `bun-worker-${process.pid}`,
    })

    let closed = false

    const run = async () => {
      await worker.run()
    }

    const shutdown = async () => {
      if (closed) {
        return
      }
      closed = true
      await worker.shutdown()
      await connection.close()
    }

    return { run, shutdown }
  } catch (error) {
    await connection.close()
    throw error
  }
}
