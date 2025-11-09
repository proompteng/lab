import { describe, expect, test } from 'bun:test'
import { Context, Effect, Layer } from 'effect'

import { makeConsoleLogger } from '../../src/observability/logger'
import { makeInMemoryMetrics } from '../../src/observability/metrics'
import { temporalDefaults, type TemporalConfig } from '../../src/config'
import { makeStickyCache } from '../../src/worker/sticky-cache'
import type { WorkerScheduler } from '../../src/worker/concurrency'
import { defineWorkflow } from '../../src/workflow/definition'
import { WorkerRuntime } from '../../src/worker/runtime'
import {
  WorkerRuntimeService,
  configLayerFromValue,
  loggerLayerFromValue,
  makeWorkerLayer,
  metricsLayerFromRegistry,
  stickyCacheLayerFromValue,
  workerSchedulerLayerFromValue,
  workflowServiceLayerFromClient,
} from '../../src/runtime/effect-layers'
import type { WorkflowServiceClient } from '../../src/worker/runtime'

const baseConfig: TemporalConfig = {
  ...temporalDefaults,
  host: '127.0.0.1',
  port: 7233,
  address: '127.0.0.1:7233',
  taskQueue: 'test-queue',
  namespace: 'default',
  apiKey: undefined,
  tls: undefined,
  allowInsecureTls: true,
  workerIdentity: 'test-worker',
  showStackTraceSources: false,
  workflowContextBypass: false,
  workerDeploymentName: 'test-deployment',
  workerBuildId: 'test-build',
}

describe('WorkerLayer', () => {
  test('composes dependencies and exposes WorkerRuntimeService', async () => {
    const logger = makeConsoleLogger()
    const metrics = await Effect.runPromise(makeInMemoryMetrics())
    const stickyCache = await Effect.runPromise(makeStickyCache({ maxEntries: 0, ttlMs: 0 }))
    const scheduler: WorkerScheduler = {
      start: Effect.void,
      stop: Effect.void,
      enqueueWorkflow: () => Effect.void,
      enqueueActivity: () => Effect.void,
    }
    const workflow = defineWorkflow('test-workflow', () => Effect.succeed('ok'))

    const baseLayer = Layer.mergeAll(
      configLayerFromValue(baseConfig),
      loggerLayerFromValue(logger),
      metricsLayerFromRegistry(metrics),
      stickyCacheLayerFromValue(stickyCache),
      workerSchedulerLayerFromValue(scheduler),
      workflowServiceLayerFromClient({} as WorkflowServiceClient),
    )

    const layer = makeWorkerLayer({
      config: baseConfig,
      namespace: baseConfig.namespace,
      taskQueue: baseConfig.taskQueue,
      workflows: [workflow],
      activities: {},
    }).pipe(Layer.provide(baseLayer))

    const service = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          return Context.get(context, WorkerRuntimeService)
        }),
      ),
    )

    expect(service.runtime).toBeInstanceOf(WorkerRuntime)
    await service.runtime.shutdown()
  })
})
