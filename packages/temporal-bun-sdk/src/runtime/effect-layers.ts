import { Context, Effect, Layer } from 'effect'

import { loadTemporalConfig, type TemporalConfig } from '../config'
import { type Logger, makeConsoleLogger } from '../observability/logger'
import type { MetricsRegistry } from '../observability/metrics'
import { makeInMemoryMetrics } from '../observability/metrics'
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

export const ConfigLayer: Layer.Layer<never, unknown, TemporalConfigService> = Layer.effect(
  TemporalConfigService,
  Effect.tryPromise({
    try: () => loadTemporalConfig(),
    catch: (error) => error,
  }),
)

export const LoggerLayer: Layer.Layer<never, never, LoggerService> = Layer.succeed(LoggerService, makeConsoleLogger())

export const MetricsLayer: Layer.Layer<never, never, MetricsService> = Layer.effect(
  MetricsService,
  makeInMemoryMetrics(),
)

export const WorkflowServiceLayer: Layer.Layer<never, unknown, WorkflowServiceClientService> = Layer.effect(
  WorkflowServiceClientService,
  Effect.fail(new Error('WorkflowServiceLayer not implemented')) as Effect.Effect<
    WorkflowServiceClient,
    unknown,
    never
  >,
)
