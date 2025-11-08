import { createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Context, Effect, Layer } from 'effect'

import { buildTransportOptions, normalizeTemporalAddress } from '../client'
import { loadTemporalConfigEffect, type TemporalConfig, type TemporalConfigError } from '../config'
import { type Logger, makeConsoleLogger } from '../observability/logger'
import type { MetricsRegistry } from '../observability/metrics'
import { makeInMemoryMetrics } from '../observability/metrics'
import { WorkflowService } from '../proto/temporal/api/workflowservice/v1/service_pb'
import type { WorkerScheduler, WorkerSchedulerHooks } from '../worker/concurrency'
import { makeWorkerScheduler } from '../worker/concurrency'
import type { WorkflowServiceClient } from '../worker/runtime'
import { WorkerRuntime, type WorkerRuntimeOptions } from '../worker/runtime'
import type { StickyCache } from '../worker/sticky-cache'
import { makeStickyCache } from '../worker/sticky-cache'

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

export class StickyCacheService extends Context.Tag('@proompteng/temporal-bun-sdk/StickyCache')<
  StickyCacheService,
  StickyCache
>() {}

export class WorkerSchedulerService extends Context.Tag('@proompteng/temporal-bun-sdk/WorkerScheduler')<
  WorkerSchedulerService,
  WorkerScheduler
>() {}

export interface WorkerRuntimeHandle {
  readonly runtime: WorkerRuntime
  readonly run: Effect.Effect<void, unknown, never>
  readonly shutdown: Effect.Effect<void, unknown, never>
}

export class WorkerRuntimeService extends Context.Tag('@proompteng/temporal-bun-sdk/WorkerRuntime')<
  WorkerRuntimeService,
  WorkerRuntimeHandle
>() {}

const closable = (transport: ReturnType<typeof createGrpcTransport>) =>
  transport as ReturnType<typeof createGrpcTransport> & { close?: () => void | Promise<void> }

const acquireWorkflowService = Effect.acquireRelease(
  Effect.gen(function* () {
    const config = yield* TemporalConfigService
    const logger = yield* LoggerService
    const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
    const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
    const transport = closable(createGrpcTransport(buildTransportOptions(baseUrl, config)))
    const client = createClient(WorkflowService, transport)
    return { client, transport, logger }
  }),
  ({ transport, logger }) =>
    Effect.tryPromise({
      try: async () => {
        if (typeof transport.close === 'function') {
          await transport.close()
        }
      },
      catch: (cause) => cause,
    }).pipe(Effect.catchAll((cause) => logger.log('warn', 'WorkflowService transport close failed', { cause }))),
).pipe(Effect.map(({ client }) => client))

export const ConfigLayer: Layer.Layer<never, TemporalConfigError, TemporalConfigService> = Layer.effect(
  TemporalConfigService,
  loadTemporalConfigEffect(),
)
// TODO(TBS-010): Accept CLI/test overrides via Layer.provideContext once config flags land.

export const LoggerLayer: Layer.Layer<never, never, LoggerService> = Layer.succeed(LoggerService, makeConsoleLogger())

export const MetricsLayer: Layer.Layer<never, never, MetricsService> = Layer.scoped(
  MetricsService,
  makeInMemoryMetrics(),
)

export const WorkflowServiceLayer = Layer.scoped(WorkflowServiceClientService, acquireWorkflowService)

export interface StickyCacheLayerOptions {
  readonly size?: number
  readonly ttlMs?: number
}

export const makeStickyCacheLayer = (options: StickyCacheLayerOptions = {}) =>
  Layer.scoped(
    StickyCacheService,
    Effect.flatMap(TemporalConfigService, (config) =>
      makeStickyCache({
        maxEntries: options.size ?? config.workerStickyCacheSize,
        ttlMs: options.ttlMs ?? config.workerStickyTtlMs,
      }),
    ),
  )
// TODO(TBS-001): Surface cache metrics + eviction hooks.

export const StickyCacheLayer = makeStickyCacheLayer()

export interface WorkerSchedulerLayerOptions {
  readonly workflowConcurrency?: number
  readonly activityConcurrency?: number
  readonly hooks?: WorkerSchedulerHooks
}

export const makeWorkerSchedulerLayer = (options: WorkerSchedulerLayerOptions = {}) =>
  Layer.scoped(
    WorkerSchedulerService,
    Effect.flatMap(TemporalConfigService, (config) =>
      makeWorkerScheduler({
        workflowConcurrency: options.workflowConcurrency ?? config.workerWorkflowConcurrency,
        activityConcurrency: options.activityConcurrency ?? config.workerActivityConcurrency,
        hooks: options.hooks,
      }),
    ),
  )

export const WorkerSchedulerLayer = makeWorkerSchedulerLayer()

const makeCoreRuntimeLayer = (configLayer: Layer.Layer<never, TemporalConfigError, TemporalConfigService>) =>
  Layer.mergeAll(configLayer, LoggerLayer)

const makeBaseRuntimeLayer = (configLayer: Layer.Layer<never, TemporalConfigError, TemporalConfigService>) => {
  const coreRuntimeLayer = makeCoreRuntimeLayer(configLayer)
  const workflowServiceLiveLayer = WorkflowServiceLayer.pipe(Layer.provide(coreRuntimeLayer))
  const stickyCacheLiveLayer = StickyCacheLayer.pipe(Layer.provide(coreRuntimeLayer))
  const workerSchedulerLiveLayer = WorkerSchedulerLayer.pipe(Layer.provide(coreRuntimeLayer))

  return Layer.mergeAll(
    coreRuntimeLayer,
    MetricsLayer,
    stickyCacheLiveLayer,
    workerSchedulerLiveLayer,
    workflowServiceLiveLayer,
  )
}

export const BaseRuntimeLayer = makeBaseRuntimeLayer(ConfigLayer)
export { makeBaseRuntimeLayer }

export interface WorkerLayerOptions extends WorkerRuntimeOptions {}

export const makeWorkerLayer = (options: WorkerLayerOptions = {}) =>
  Layer.scoped(
    WorkerRuntimeService,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const config = options.config ?? (yield* TemporalConfigService)
        const logger = options.logger ?? (yield* LoggerService)
        const metrics = options.metrics ?? (yield* MetricsService)
        const workflowClient = options.workflowService ?? (yield* WorkflowServiceClientService)
        const scheduler = options.scheduler ?? (yield* WorkerSchedulerService)
        const stickyCache = options.stickyCache ?? (yield* StickyCacheService)
        return yield* Effect.promise(() =>
          WorkerRuntime.create({
            ...options,
            config,
            workflowService: workflowClient,
            scheduler,
            stickyCache,
            logger,
            metrics,
          }),
        )
      }),
      (runtime) => Effect.promise(() => runtime.shutdown()),
    ).pipe(
      Effect.map(
        (runtime) =>
          ({
            runtime,
            run: Effect.promise(() => runtime.run()),
            shutdown: Effect.promise(() => runtime.shutdown()),
          }) satisfies WorkerRuntimeHandle,
      ),
    ),
  )

export const WorkerLayer = makeWorkerLayer()

export const configLayerFromValue = (config: TemporalConfig): Layer.Layer<never, never, TemporalConfigService> =>
  Layer.succeed(TemporalConfigService, config)

export const loggerLayerFromValue = (logger: Logger): Layer.Layer<never, never, LoggerService> =>
  Layer.succeed(LoggerService, logger)

export const metricsLayerFromRegistry = (registry: MetricsRegistry): Layer.Layer<never, never, MetricsService> =>
  Layer.succeed(MetricsService, registry)

export const workflowServiceLayerFromClient = (
  client: WorkflowServiceClient,
): Layer.Layer<never, never, WorkflowServiceClientService> => Layer.succeed(WorkflowServiceClientService, client)

export const stickyCacheLayerFromValue = (cache: StickyCache): Layer.Layer<never, never, StickyCacheService> =>
  Layer.succeed(StickyCacheService, cache)

export const workerSchedulerLayerFromValue = (
  scheduler: WorkerScheduler,
): Layer.Layer<never, never, WorkerSchedulerService> => Layer.succeed(WorkerSchedulerService, scheduler)
