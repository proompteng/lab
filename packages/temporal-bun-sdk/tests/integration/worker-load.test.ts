import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Effect } from 'effect'

import {
  createIntegrationHarness,
  type IntegrationHarness,
  type TemporalDevServerConfig,
} from './harness'
import { readWorkerLoadConfig } from './load/config'
import { runWorkerLoad } from './load/runner'

const shouldRunIntegration = process.env.TEMPORAL_INTEGRATION_TESTS === '1'
const describeIntegration = shouldRunIntegration ? describe : describe.skip

const devServerDefaults: TemporalDevServerConfig = {
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
}

const loadSuiteDefaults = readWorkerLoadConfig()

const harnessConfig: TemporalDevServerConfig = {
  ...devServerDefaults,
  cliLogPath: loadSuiteDefaults.cliLogPath,
}

describeIntegration('worker runtime load/perf suite', () => {
  let harness: IntegrationHarness

  beforeAll(async () => {
    harness = await Effect.runPromise(createIntegrationHarness(harnessConfig))
    await Effect.runPromise(harness.setup)
  })

  afterAll(async () => {
    await Effect.runPromise(harness.teardown)
  })

  test(
    'meets throughput, latency, and sticky cache thresholds',
    { timeout: loadSuiteDefaults.workflowDurationBudgetMs },
    async () => {
      const loadConfig = readWorkerLoadConfig()
      const envOverrides = {
        ...loadConfig.metricEnv,
        TEMPORAL_WORKFLOW_CONCURRENCY: String(loadConfig.workflowConcurrencyTarget),
        TEMPORAL_ACTIVITY_CONCURRENCY: String(loadConfig.activityConcurrencyTarget),
        TEMPORAL_STICKY_SCHEDULING_ENABLED: '1',
      }

    const result = await Effect.runPromise(
      harness.runScenario(
        'worker load/perf',
        () =>
          Effect.tryPromise(() =>
            runWorkerLoad({
              harness,
              address: harnessConfig.address,
              namespace: harnessConfig.namespace,
              loadConfig,
            }),
          ),
        { env: envOverrides },
      ),
    )

    expect(result.stats.completed).toBeGreaterThanOrEqual(result.stats.submitted)
    expect(result.stats.peakConcurrent).toBeGreaterThanOrEqual(
      Math.min(loadConfig.workflowConcurrencyTarget, result.stats.submitted),
    )
    expect(result.summary.workflowThroughputPerSecond).toBeGreaterThanOrEqual(
      loadConfig.throughputFloorPerSecond,
    )
    expect(result.summary.stickyHitRatio).toBeGreaterThanOrEqual(loadConfig.stickyHitRatioTarget)
    expect(result.summary.workflowPollLatency?.p95 ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      loadConfig.workflowPollP95TargetMs,
    )
    expect(result.summary.activityPollLatency?.p95 ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      loadConfig.activityPollP95TargetMs,
    )
    },
  )
})
