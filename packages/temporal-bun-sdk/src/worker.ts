import { fileURLToPath } from 'node:url'
import { NativeConnection, type NativeConnectionOptions, Worker, type WorkerOptions } from '@temporalio/worker'
import * as defaultActivities from './activities'
import { loadTemporalConfig, type TemporalConfig } from './config'

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
