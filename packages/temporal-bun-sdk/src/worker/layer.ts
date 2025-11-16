import { Cause, Context, Effect, Exit, Fiber, Layer } from 'effect'

import {
  LoggerService,
  MetricsExporterService,
  MetricsService,
  TemporalConfigService,
  WorkflowServiceClientService,
} from '../runtime/effect-layers'
import type { WorkerRuntimeOptions } from './runtime'
import { WorkerRuntime } from './runtime'

export class WorkerRuntimeService extends Context.Tag('@proompteng/temporal-bun-sdk/WorkerRuntime')<
  WorkerRuntimeService,
  WorkerRuntime
>() {}

export const makeWorkerRuntimeEffect = (options: WorkerRuntimeOptions = {}) =>
  Effect.gen(function* () {
    const config = options.config ?? (yield* TemporalConfigService)
    const namespace = options.namespace ?? config.namespace
    const taskQueue = options.taskQueue ?? config.taskQueue
    if (!namespace) {
      throw new Error('A namespace must be provided to start the Temporal worker runtime.')
    }
    if (!taskQueue) {
      throw new Error('A task queue must be provided to start the Temporal worker runtime.')
    }
    const logger = options.logger ?? (yield* LoggerService)
    const metricsRegistry = options.metrics ?? (yield* MetricsService)
    const metricsExporter = options.metricsExporter ?? (yield* MetricsExporterService)
    const workflowService = options.workflowService ?? (yield* WorkflowServiceClientService)

    return yield* Effect.promise(() =>
      WorkerRuntime.create({
        ...options,
        namespace,
        taskQueue,
        config,
        logger,
        metrics: metricsRegistry,
        metricsExporter,
        workflowService,
      }),
    )
  })

export const runWorkerEffect = (options: WorkerRuntimeOptions = {}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const parentFiber = (yield* Effect.withFiberRuntime((fiber) => Effect.succeed(fiber))) as Fiber.RuntimeFiber<
        unknown,
        unknown
      >
      const runtime = yield* makeWorkerRuntimeEffect(options)
      const runFiber = yield* Effect.forkDaemon(Effect.promise(() => runtime.run()))
      yield* Effect.addFinalizer(() => Fiber.interruptFork(runFiber))
      yield* Effect.sync(() => {
        runFiber.addObserver((exit) => {
          if (Exit.isFailure(exit)) {
            const error = Cause.pretty(exit.cause)
            Effect.runFork(
              Effect.logError('temporal worker runtime failed', error).pipe(
                Effect.zipRight(parentFiber.interruptAsFork(runFiber.id())),
              ),
            )
          }
        })
      })
      return runtime
    }),
    (runtime) => Effect.promise(() => runtime.shutdown()),
  )

export const createWorkerRuntimeLayer = (options: WorkerRuntimeOptions = {}) =>
  Layer.scoped(WorkerRuntimeService, runWorkerEffect(options))

export const WorkerRuntimeLayer = createWorkerRuntimeLayer()
