import { metrics as otelMetrics } from '@opentelemetry/api'
import { Effect, Layer } from 'effect'

import { loadTemporalConfig, type TemporalConfig } from '../config'
import { createLogger, type Logger } from '../observability/logger'
import type { MetricsRegistry } from '../observability/metrics'
import { makeInMemoryMetrics, makeOpenTelemetryMetrics } from '../observability/metrics'
import { makeNoopTracer, makeOpenTelemetryTracer, type Tracer } from '../observability/tracing'
import type { WorkflowServiceClient } from '../worker/runtime'

export class TemporalConfigService extends Effect.Tag('@proompteng/temporal-bun-sdk/TemporalConfig')<
  TemporalConfigService,
  TemporalConfig
>() {}

export class LoggerService extends Effect.Tag('@proompteng/temporal-bun-sdk/Logger')<LoggerService, Logger>() {}

export class MetricsService extends Effect.Tag('@proompteng/temporal-bun-sdk/Metrics')<
  MetricsService,
  MetricsRegistry
>() {}

export class TracingService extends Effect.Tag('@proompteng/temporal-bun-sdk/Tracing')<TracingService, Tracer>() {}

export class WorkflowServiceClientService extends Effect.Tag('@proompteng/temporal-bun-sdk/WorkflowServiceClient')<
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

export const LoggerLayer: Layer.Layer<TemporalConfigService, never, LoggerService> = Layer.effect(
  LoggerService,
  Effect.gen(function* () {
    const config = yield* TemporalConfigService
    const observability = config.observability ?? {}
    const loggerConfig = observability.logger ?? {}

    return createLogger({
      level: loggerConfig.level,
      format: loggerConfig.format ?? 'json',
      fields: {
        component: 'temporal-bun-sdk',
        namespace: config.namespace,
        taskQueue: config.taskQueue,
      },
    })
  }),
)

export const MetricsLayer: Layer.Layer<TemporalConfigService, never, MetricsService> = Layer.effect(
  MetricsService,
  Effect.gen(function* () {
    const config = yield* TemporalConfigService
    const observability = config.observability ?? {}
    const metricsConfig = observability.metrics ?? {}

    if (metricsConfig.exporter === 'otel') {
      const meter =
        metricsConfig.meter ??
        otelMetrics.getMeter(metricsConfig.meterName ?? 'temporal-bun-sdk', {
          schemaUrl: metricsConfig.schemaUrl,
          version: metricsConfig.meterVersion,
        })
      return makeOpenTelemetryMetrics(meter)
    }

    return yield* makeInMemoryMetrics()
  }),
)

export const TracingLayer: Layer.Layer<TemporalConfigService, never, TracingService> = Layer.effect(
  TracingService,
  Effect.gen(function* () {
    const config = yield* TemporalConfigService
    const tracingConfig = config.observability?.tracing

    if (!tracingConfig || !tracingConfig.enabled || tracingConfig.exporter === 'none') {
      return makeNoopTracer()
    }

    return makeOpenTelemetryTracer({ serviceName: tracingConfig.serviceName })
  }),
)

export const WorkflowServiceLayer: Layer.Layer<never, unknown, WorkflowServiceClientService> = Layer.effect(
  WorkflowServiceClientService,
  Effect.fail(new Error('WorkflowServiceLayer not implemented')) as Effect.Effect<
    WorkflowServiceClient,
    unknown,
    never
  >,
)
