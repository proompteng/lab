import { afterEach, describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Layer } from 'effect'

import { createObservabilityStub, createTestTemporalConfig } from './helpers/observability'
import type { TemporalConfig } from '../src/config'
import {
  LoggerService,
  MetricsExporterService,
  MetricsService,
  TemporalConfigService,
  WorkflowServiceClientService,
} from '../src/runtime/effect-layers'
import type { WorkflowServiceClient } from '../src/runtime/effect-layers'
import {
  createWorkerRuntimeLayer,
  makeWorkerRuntimeEffect,
  runWorkerEffect,
  WorkerRuntimeFailureSignal,
  WorkerRuntimeLayer,
} from '../src/worker/layer'
import { WorkerRuntime } from '../src/worker/runtime'

const stubWorkflowService = {} as WorkflowServiceClient

describe('worker layers', () => {
  const originalCreate = WorkerRuntime.create

  afterEach(() => {
    WorkerRuntime.create = originalCreate
  })

  test('makeWorkerRuntimeEffect consumes context-provided services', async () => {
    const config = createTestTemporalConfig({ taskQueue: 'layer-queue', namespace: 'layer-namespace' })
    const observability = createObservabilityStub()
    const createdOptions: Record<string, unknown>[] = []
    WorkerRuntime.create = (async (options) => {
      createdOptions.push(options)
      return {
        run: async () => undefined,
        shutdown: async () => undefined,
      } as unknown as WorkerRuntime
    })

    const layer = Layer.mergeAll(
      Layer.succeed(TemporalConfigService, config),
      Layer.succeed(LoggerService, observability.services.logger),
      Layer.succeed(MetricsService, observability.services.metricsRegistry),
      Layer.succeed(MetricsExporterService, observability.services.metricsExporter),
      Layer.succeed(WorkflowServiceClientService, stubWorkflowService),
    )

    await Effect.runPromise(Effect.provide(makeWorkerRuntimeEffect({ taskQueue: 'override-queue' }), layer))

    expect(createdOptions).toHaveLength(1)
    const [first] = createdOptions
    expect(first?.config).toBe(config)
    expect(first?.taskQueue).toBe('override-queue')
    expect(first?.namespace).toBe('layer-namespace')
  })

  test('runWorkerEffect starts runtime and shuts down on scope release', async () => {
    const config = createTestTemporalConfig()
    let runCalls = 0
    let shutdownCalls = 0
    WorkerRuntime.create = (async () => ({
      run: async () => {
        runCalls += 1
      },
      shutdown: async () => {
        shutdownCalls += 1
      },
    })) as typeof WorkerRuntime.create

    const layer = baseWorkerLayer(config)

    await Effect.runPromise(
      Effect.scoped(Effect.provide(runWorkerEffect({ taskQueue: config.taskQueue, namespace: config.namespace }), layer)),
    )

    expect(runCalls).toBe(1)
    expect(shutdownCalls).toBe(1)
  })

  test('runWorkerEffect propagates runtime failures', async () => {
    const config = createTestTemporalConfig()
    let shutdownCalls = 0
    WorkerRuntime.create = (async () => ({
      run: async () => {
        throw new Error('worker runtime crash')
      },
      shutdown: async () => {
        shutdownCalls += 1
      },
    })) as typeof WorkerRuntime.create

    const workerLayer = createWorkerRuntimeLayer({ taskQueue: config.taskQueue, namespace: config.namespace }).pipe(
      Layer.provide(baseWorkerLayer(config)),
    )

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const failureSignal = yield* WorkerRuntimeFailureSignal
            return yield* failureSignal
          }),
          workerLayer,
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Cause.pretty(exit.cause)).toContain('worker runtime crash')
    expect(shutdownCalls).toBe(1)
  })

  test('WorkerRuntimeLayer provides default workflowsPath', async () => {
    const config = createTestTemporalConfig()
    let receivedOptions: Record<string, unknown> | undefined
    WorkerRuntime.create = (async (options) => {
      receivedOptions = options
      return {
        run: async () => undefined,
        shutdown: async () => undefined,
      } as unknown as WorkerRuntime
    }) as typeof WorkerRuntime.create

    const layer = WorkerRuntimeLayer.pipe(Layer.provide(baseWorkerLayer(config)))

    await Effect.runPromise(Effect.scoped(Effect.provide(Effect.succeed(undefined), layer)))

    expect(receivedOptions?.workflowsPath).toBeDefined()
    expect(typeof receivedOptions?.workflowsPath).toBe('string')
  })
})

const baseWorkerLayer = (config: TemporalConfig) => {
  const observability = createObservabilityStub()
  return Layer.mergeAll(
    Layer.succeed(TemporalConfigService, config),
    Layer.succeed(LoggerService, observability.services.logger),
    Layer.succeed(MetricsService, observability.services.metricsRegistry),
    Layer.succeed(MetricsExporterService, observability.services.metricsExporter),
    Layer.succeed(WorkflowServiceClientService, stubWorkflowService),
  )
}
