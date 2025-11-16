import { Cause, Context, Effect, Exit, Fiber, Layer } from 'effect'
import * as Deferred from 'effect/Deferred'
import type { Scope as ScopeTypes } from 'effect/Scope'
import * as Scope from 'effect/Scope'

import {
  LoggerService,
  MetricsExporterService,
  MetricsService,
  TemporalConfigService,
  WorkflowServiceClientService,
} from '../runtime/effect-layers'
import { resolveWorkerActivities, resolveWorkerWorkflowsPath } from './defaults'
import type { WorkerRuntimeOptions } from './runtime'
import { WorkerRuntime } from './runtime'

export class WorkerRuntimeService extends Context.Tag('@proompteng/temporal-bun-sdk/WorkerRuntime')<
  WorkerRuntimeService,
  WorkerRuntime
>() {}

export class WorkerRuntimeFailureSignal extends Context.Tag('@proompteng/temporal-bun-sdk/WorkerRuntimeFailureSignal')<
  WorkerRuntimeFailureSignal,
  Deferred.Deferred<never, unknown>
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

export const runWorkerEffect = (
  options: WorkerRuntimeOptions = {},
  failureSignal?: Deferred.Deferred<never, unknown>,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const scope = (yield* Effect.scope) as ScopeTypes.Closeable
      const signal = failureSignal ?? (yield* Deferred.make<never, unknown>())
      const resolvedOptions = resolveWorkerLayerOptions(options)
      const runtime = yield* makeWorkerRuntimeEffect(resolvedOptions)
      const runFiber = yield* Effect.forkDaemon(Effect.promise(() => runtime.run()))
      yield* Effect.addFinalizer(() => Fiber.interruptFork(runFiber))
      yield* Effect.addFinalizer(() => Deferred.interrupt(signal))
      yield* Effect.sync(() => {
        runFiber.addObserver((exit) => {
          if (Exit.isFailure(exit)) {
            const error = Cause.pretty(exit.cause)
            Effect.runFork(
              Effect.logError('temporal worker runtime failed', error).pipe(
                Effect.zipRight(Deferred.failCause(signal, exit.cause)),
                Effect.zipRight(Scope.close(scope, exit)),
              ),
            )
          } else {
            Effect.runFork(Deferred.interrupt(signal))
          }
        })
      })
      return runtime
    }),
    (runtime) => Effect.promise(() => runtime.shutdown()),
  )

export const createWorkerRuntimeLayer = (options: WorkerRuntimeOptions = {}) =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const failureSignal = yield* Deferred.make<never, unknown>()
      const runtime = yield* runWorkerEffect(options, failureSignal)
      let context = Context.make(WorkerRuntimeService, runtime)
      context = Context.add(context, WorkerRuntimeFailureSignal, failureSignal)
      return context
    }),
  )

export const WorkerRuntimeLayer = createWorkerRuntimeLayer()

export const resolveWorkerLayerOptions = (worker?: WorkerRuntimeOptions): WorkerRuntimeOptions => ({
  ...worker,
  activities: worker?.activities ?? resolveWorkerActivities(undefined),
  workflowsPath: worker?.workflowsPath ?? resolveWorkerWorkflowsPath(undefined),
  deployment: worker?.deployment,
})
