import { Context, Effect, Layer, Option } from 'effect'

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
    const logger = options.logger ?? (yield* LoggerService)
    const metrics = options.metrics ?? (yield* MetricsService)
    const metricsExporter = options.metricsExporter ?? (yield* MetricsExporterService)
    const workflowServiceFromContext = yield* Effect.contextWith((context) =>
      Context.getOption(context, WorkflowServiceClientService),
    )
    const workflowService = options.workflowService ?? Option.getOrUndefined(workflowServiceFromContext)

    return yield* Effect.promise(() =>
      WorkerRuntime.create({
        ...options,
        config,
        logger,
        metrics,
        metricsExporter,
        workflowService,
      }),
    )
  })

export const runWorkerEffect = (options: WorkerRuntimeOptions = {}) =>
  Effect.acquireRelease(
    makeWorkerRuntimeEffect(options).pipe(
      Effect.tap((runtime) =>
        Effect.sync(() => {
          void runtime.run().catch(() => undefined)
        }),
      ),
    ),
    (runtime) => Effect.promise(() => runtime.shutdown()),
  )

export const createWorkerRuntimeLayer = (options: WorkerRuntimeOptions = {}) =>
  Layer.scoped(WorkerRuntimeService, runWorkerEffect(options))

export const WorkerRuntimeLayer = createWorkerRuntimeLayer()
