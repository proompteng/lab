import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Effect, Exit } from 'effect'

import { createIntegrationHarness, findTemporalCliUnavailableError, type IntegrationHarness, type TemporalDevServerConfig } from './harness'
import { readWorkerLoadConfig } from './load/config'
import { runWorkerLoad } from './load/runner'

const shouldRunIntegration = process.env.TEMPORAL_INTEGRATION_TESTS === '1'
const describeIntegration = shouldRunIntegration ? describe : describe.skip

const devServerDefaults: TemporalDevServerConfig = {
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
}

const loadSuiteDefaults = readWorkerLoadConfig()
const testTimeoutBudgetMs =
  loadSuiteDefaults.workflowDurationBudgetMs +
  Math.max(loadSuiteDefaults.metricsFlushTimeoutMs, 5_000) +
  15_000
const hookTimeoutMs = 60_000

describeIntegration('worker runtime load/perf suite', () => {
  let harness: IntegrationHarness | null = null
  let cliUnavailable = false

  beforeAll(async () => {
    const harnessExit = await Effect.runPromiseExit(createIntegrationHarness(devServerDefaults))
    if (Exit.isFailure(harnessExit)) {
      const unavailable = findTemporalCliUnavailableError(harnessExit.cause)
      if (unavailable) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] skipping worker-load integration: ${unavailable.message}`)
        return
      }
      throw harnessExit.cause
    }
    harness = harnessExit.value

    const setupExit = await Effect.runPromiseExit(harness.setup)
    if (Exit.isFailure(setupExit)) {
      const unavailable = findTemporalCliUnavailableError(setupExit.cause)
      if (unavailable) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] skipping worker-load integration: ${unavailable.message}`)
        return
      }
      throw setupExit.cause
    }
  }, { timeout: hookTimeoutMs })

  afterAll(async () => {
    if (harness) {
      await Effect.runPromise(harness.teardown)
    }
  }, { timeout: hookTimeoutMs })

  test(
    'meets throughput, latency, and sticky cache thresholds',
    { timeout: testTimeoutBudgetMs },
    async () => {
      if (cliUnavailable) {
        console.warn('[temporal-bun-sdk] worker-load scenario skipped (Temporal endpoint unavailable)')
        return
      }

      const loadConfig = readWorkerLoadConfig()
      const envOverrides = {
        ...loadConfig.metricEnv,
        TEMPORAL_WORKFLOW_CONCURRENCY: String(loadConfig.workflowConcurrencyTarget),
        TEMPORAL_ACTIVITY_CONCURRENCY: String(loadConfig.activityConcurrencyTarget),
        TEMPORAL_STICKY_SCHEDULING_ENABLED: '1',
      }

      const result = await Effect.runPromise(
        Effect.tryPromise(() =>
          withEnvironment(envOverrides, () =>
            runWorkerLoad({
              address: devServerDefaults.address,
              namespace: devServerDefaults.namespace,
              loadConfig,
            }),
          ),
        ),
      )

      expect(result.stats.completed).toBeGreaterThanOrEqual(result.stats.submitted)
      const expectedConcurrencyFloor = Math.max(
        1,
        Math.ceil(Math.min(loadConfig.workflowConcurrencyTarget, result.stats.submitted) * 0.2),
      )
      expect(result.stats.peakConcurrent).toBeGreaterThanOrEqual(expectedConcurrencyFloor)
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

const withEnvironment = async <A>(env: Record<string, string | undefined>, action: () => Promise<A>): Promise<A> => {
  const snapshot = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    snapshot.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    return await action()
  } finally {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
