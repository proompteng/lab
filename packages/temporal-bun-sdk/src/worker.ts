import type { DataConverter } from './common/payloads'
import { loadTemporalConfig, type TemporalConfig } from './config'
import {
  deriveWorkerBuildId,
  deriveWorkerBuildIdFromWorkflowsPath,
  resolveWorkerActivities,
  resolveWorkerWorkflowsPath,
} from './worker/defaults'
import type { ActivityHandler, WorkerDeploymentConfig } from './worker/runtime'
import { WorkerRuntime } from './worker/runtime'
import type { WorkflowDefinitions } from './workflow/definition'

export { WorkerVersioningMode } from './proto/temporal/api/enums/v1/deployment_pb'
export { VersioningBehavior } from './proto/temporal/api/enums/v1/workflow_pb'

export interface CreateWorkerOptions {
  config?: TemporalConfig
  taskQueue?: string
  namespace?: string
  workflowsPath?: string
  workflows?: WorkflowDefinitions
  activities?: Record<string, ActivityHandler>
  dataConverter?: DataConverter
  identity?: string
  deployment?: WorkerDeploymentConfig
  workflowGuards?: TemporalConfig['workflowGuards']
  workflowLint?: TemporalConfig['workflowLint']
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
  const activities = resolveWorkerActivities(options.activities)
  const workflowsPath = resolveWorkerWorkflowsPath(options.workflowsPath)
  const derivedBuildId =
    options.deployment?.buildId ??
    options.config?.workerBuildId ??
    deriveWorkerBuildIdFromWorkflowsPath(workflowsPath) ??
    deriveWorkerBuildId()
  const config = await resolveWorkerConfig(options, derivedBuildId)
  if (config.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }
  const taskQueue = config.taskQueue
  if (!taskQueue) {
    throw new Error('A task queue must be provided to start the Temporal worker runtime.')
  }
  const namespace = config.namespace
  if (!namespace) {
    throw new Error('A namespace must be provided to start the Temporal worker runtime.')
  }
  const runtime = await WorkerRuntime.create({
    workflowsPath,
    workflows: options.workflows,
    activities,
    taskQueue,
    namespace,
    dataConverter: options.dataConverter,
    identity: options.identity,
    workflowGuards: options.workflowGuards,
    workflowLint: options.workflowLint,
    config,
    deployment: {
      ...options.deployment,
      buildId: options.deployment?.buildId ?? config.workerBuildId,
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

const resolveWorkerConfig = async (options: CreateWorkerOptions, derivedBuildId: string): Promise<TemporalConfig> => {
  if (options.config) {
    const provided: TemporalConfig = {
      ...options.config,
      taskQueue: options.taskQueue ?? options.config.taskQueue,
      namespace: options.namespace ?? options.config.namespace,
      workerBuildId: options.config.workerBuildId ?? derivedBuildId,
      payloadCodecs: options.config.payloadCodecs ?? [],
    }
    return provided
  }

  const config = await loadTemporalConfig({
    defaults: {
      namespace: options.namespace,
      taskQueue: options.taskQueue,
      workerBuildId: derivedBuildId,
    },
  })
  if (options.namespace) {
    config.namespace = options.namespace
  }
  if (options.taskQueue) {
    config.taskQueue = options.taskQueue
  }
  if (!config.workerBuildId) {
    config.workerBuildId = derivedBuildId
  }
  return config
}
