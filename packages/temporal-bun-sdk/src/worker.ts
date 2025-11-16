import { Effect, Layer } from 'effect'

import type { DataConverter } from './common/payloads'
import type { TemporalConfig } from './config'
import type {
  LoggerService,
  MetricsExporterService,
  MetricsService,
  WorkflowServiceClientService,
} from './runtime/effect-layers'
import {
  createConfigLayer,
  createObservabilityLayer,
  createWorkflowServiceLayer,
  TemporalConfigService,
} from './runtime/effect-layers'
import { deriveWorkerBuildId, resolveWorkerActivities, resolveWorkerWorkflowsPath } from './worker/defaults'
import { makeWorkerRuntimeEffect } from './worker/layer'
import type { ActivityHandler, WorkerDeploymentConfig, WorkerRuntime } from './worker/runtime'
import type { WorkflowDefinitions } from './workflow/definition'

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
  const derivedBuildId = options.config?.workerBuildId ?? deriveWorkerBuildId()
  const configLayer = buildWorkerConfigLayer(options, derivedBuildId)
  const observabilityLayer = createObservabilityLayer().pipe(Layer.provide(configLayer))
  const workflowLayer = createWorkflowServiceLayer()
    .pipe(Layer.provide(configLayer))
    .pipe(Layer.provide(observabilityLayer))
  const mergedLayer = Layer.mergeAll(configLayer, observabilityLayer, workflowLayer)

  const effect = Effect.gen(function* () {
    const config = yield* TemporalConfigService
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
    const runtime = yield* makeWorkerRuntimeEffect({
      workflowsPath,
      workflows: options.workflows,
      activities,
      taskQueue,
      namespace,
      dataConverter: options.dataConverter,
      identity: options.identity,
      deployment: {
        ...options.deployment,
        buildId: options.deployment?.buildId ?? config.workerBuildId,
      },
    })
    return { runtime, config }
  }) as Effect.Effect<
    { runtime: WorkerRuntime; config: TemporalConfig },
    unknown,
    TemporalConfigService | LoggerService | MetricsService | MetricsExporterService | WorkflowServiceClientService
  >

  const { runtime, config } = await Effect.runPromise(
    Effect.provide(effect, mergedLayer) as Effect.Effect<
      { runtime: WorkerRuntime; config: TemporalConfig },
      unknown,
      never
    >,
  )
  const worker = new BunWorker(runtime)

  return { worker, runtime, config }
}

export const runWorker = async (options?: CreateWorkerOptions) => {
  const result = await createWorker(options)
  await result.worker.run()
  return result.worker
}

const buildWorkerConfigLayer = (options: CreateWorkerOptions, derivedBuildId: string) => {
  if (options.config) {
    const provided: TemporalConfig = {
      ...options.config,
      taskQueue: options.taskQueue ?? options.config.taskQueue,
      namespace: options.namespace ?? options.config.namespace,
    }
    if (!provided.workerBuildId) {
      provided.workerBuildId = derivedBuildId
    }
    return Layer.succeed(TemporalConfigService, provided)
  }

  return createConfigLayer({
    overrides: {
      namespace: options.namespace,
      taskQueue: options.taskQueue,
    },
    defaults: {
      workerBuildId: derivedBuildId,
    },
  })
}
