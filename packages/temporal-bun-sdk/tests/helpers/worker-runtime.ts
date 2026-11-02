import type { TemporalConfig } from '../../src/config'
import { createObservabilityServices } from '../../src/observability'
import type { Logger } from '../../src/observability/logger'
import type { MetricsExporter, MetricsRegistry } from '../../src/observability/metrics'
import { makeWorkerRuntimeEffect } from '../../src/worker/layer'
import type { WorkerRuntime, WorkerRuntimeOptions } from '../../src/worker/runtime'
import { runEffect } from './effect'

export interface TestWorkerRuntimeOptions extends WorkerRuntimeOptions {
  readonly config: TemporalConfig
  readonly logger?: Logger
  readonly metrics?: MetricsRegistry
  readonly metricsExporter?: MetricsExporter
}

export const createTestWorkerRuntime = async ({
  config,
  logger,
  metrics,
  metricsExporter,
  ...runtimeOptions
}: TestWorkerRuntimeOptions): Promise<WorkerRuntime> => {
  const observability = await runEffect(
    createObservabilityServices(
      {
        logLevel: config.logLevel,
        logFormat: config.logFormat,
        metrics: config.metricsExporter,
      },
      {
        logger,
        metricsRegistry: metrics,
        metricsExporter,
      },
    ),
  )

  return await runEffect(
    makeWorkerRuntimeEffect({
      ...runtimeOptions,
      config,
      namespace: runtimeOptions.namespace ?? config.namespace,
      taskQueue: runtimeOptions.taskQueue ?? config.taskQueue,
      logger: observability.logger,
      metrics: runtimeOptions.metrics ?? observability.metricsRegistry,
      metricsExporter: runtimeOptions.metricsExporter ?? observability.metricsExporter,
    }),
  )
}
