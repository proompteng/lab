import { Effect } from 'effect'
import type { LogFormat, Logger, LogLevel } from './logger'
import { makeLogger } from './logger'
import type { MetricsExporter, MetricsExporterSpec, MetricsRegistry } from './metrics'
import { createMetricsExporter, createMetricsRegistry, defaultMetricsExporterSpec } from './metrics'

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
}

export const createObservabilityServices = (
  config: ObservabilityConfig,
  overrides: ObservabilityOverrides = {},
): Effect.Effect<ObservabilityServices, never, never> =>
  Effect.gen(function* () {
    const logger = overrides.logger ?? makeLogger({ level: config.logLevel, format: config.logFormat })
    const exporter = overrides.metricsExporter ?? (yield* createMetricsExporter(config.metrics))
    const registry = overrides.metricsRegistry ?? createMetricsRegistry(exporter)
    return {
      logger,
      metricsRegistry: registry,
      metricsExporter: exporter,
    }
  })

export const defaultObservabilityConfig: ObservabilityConfig = {
  logLevel: 'info',
  logFormat: 'pretty',
  metrics: defaultMetricsExporterSpec,
}
