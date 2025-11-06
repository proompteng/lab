import { Context, Effect, Layer } from 'effect'

import { makeConsoleLogger, type Logger } from '../observability/logger'
import type { MetricsRegistry } from '../observability/metrics'
import { makeInMemoryMetrics } from '../observability/metrics'
import { loadTemporalConfig, type TemporalConfig } from '../config'
import type { WorkflowServiceClient } from '../worker/runtime'

export class TemporalConfigService extends Context.Tag('@proompteng/temporal-bun-sdk/TemporalConfig')<
  TemporalConfigService,
  TemporalConfig
>() {}

export class LoggerService extends Context.Tag('@proompteng/temporal-bun-sdk/Logger')<LoggerService, Logger>() {}

export class MetricsService extends Context.Tag('@proompteng/temporal-bun-sdk/Metrics')<
  MetricsService,
  MetricsRegistry
>() {}

export class WorkflowServiceClientService extends Context.Tag('@proompteng/temporal-bun-sdk/WorkflowServiceClient')<
  WorkflowServiceClientService,
  WorkflowServiceClient
>() {}

export const ConfigLayer: Layer.Layer<never, unknown, TemporalConfigService> = Layer.scopedEffect(
  TemporalConfigService,
  Effect.tryPromise({
    try: () => loadTemporalConfig(),
    catch: (error) => error,
  }),
).pipe(
  // TODO(TBS-010): Replace with Schema-based validation and structured errors.
)

export const LoggerLayer: Layer.Layer<never, never, LoggerService> = Layer.succeed(LoggerService, makeConsoleLogger())

export const MetricsLayer: Layer.Layer<never, never, MetricsService> = Layer.effect(
  MetricsService,
  makeInMemoryMetrics(),
)

export const WorkflowServiceLayer: Layer.Layer<TemporalConfigService, unknown, WorkflowServiceClientService> =
  Layer.scopedEffect(
    WorkflowServiceClientService,
    Effect.gen(function* () {
      const config = yield* TemporalConfigService
      // TODO(TBS-010): Construct WorkflowService client using Connect transport within Effect scope.
      void config
      throw new Error('WorkflowServiceLayer not yet implemented') // placeholder to keep type safety
    }),
  )
