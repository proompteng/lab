import { Effect } from 'effect'
import type { LogFormat, Logger, LogLevel } from './logger'
import { makeLogger } from './logger'
import type { MetricsExporter, MetricsExporterSpec, MetricsRegistry } from './metrics'
import {
  cloneMetricsExporterSpec,
  createMetricsExporter,
  createMetricsRegistry,
  defaultMetricsExporterSpec,
} from './metrics'
import type { OpenTelemetryHandle } from './opentelemetry'
import { registerOpenTelemetry } from './opentelemetry'

export interface ObservabilityConfig {
  readonly logLevel: LogLevel
  readonly logFormat: LogFormat
  readonly metrics: MetricsExporterSpec
}

export interface ObservabilityOverrides {
  readonly logger?: Logger
  readonly metricsRegistry?: MetricsRegistry
  readonly metricsExporter?: MetricsExporter
}

export interface ObservabilityServices {
  readonly logger: Logger
  readonly metricsRegistry: MetricsRegistry
  readonly metricsExporter: MetricsExporter
  readonly openTelemetry?: OpenTelemetryHandle
}

export const createObservabilityServices = (
  config: ObservabilityConfig,
  overrides: ObservabilityOverrides = {},
): Effect.Effect<ObservabilityServices, never, never> =>
  Effect.gen(function* () {
    const logger = overrides.logger ?? makeLogger({ level: config.logLevel, format: config.logFormat })
    const exporter = overrides.metricsExporter ?? (yield* createMetricsExporter(config.metrics))
    const registry = overrides.metricsRegistry ?? createMetricsRegistry(exporter)
    const openTelemetry = yield* Effect.promise(() => registerOpenTelemetry()).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    )
    return {
      logger,
      metricsRegistry: registry,
      metricsExporter: exporter,
      openTelemetry,
    }
  })

export const defaultObservabilityConfig: ObservabilityConfig = {
  logLevel: 'info',
  logFormat: 'pretty',
  metrics: cloneMetricsExporterSpec(defaultMetricsExporterSpec),
}

export type { OpenTelemetryConfig, OpenTelemetryHandle } from './opentelemetry'
export { registerOpenTelemetry } from './opentelemetry'
