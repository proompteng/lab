#!/usr/bin/env bun

import { parseArgs } from 'node:util'
import { Effect, Exit } from 'effect'

import {
  createIntegrationHarness,
  findTemporalCliUnavailableError,
  type IntegrationHarness,
  type TemporalDevServerConfig,
} from '../tests/integration/harness'
import { readWorkerLoadConfig } from '../tests/integration/load/config'
import { runWorkerLoad } from '../tests/integration/load/runner'

const main = async () => {
  const argv = parseArgs({
    options: {
      workflows: { type: 'string' },
      'workflow-concurrency': { type: 'string' },
      'activity-concurrency': { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  })

  if (argv.values.help) {
    printHelp()
    return
  }

  applyOverrides(argv.values)

  const loadConfig = readWorkerLoadConfig()
  const harnessConfig: TemporalDevServerConfig = {
    address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    cliLogPath: loadConfig.cliLogPath,
  }

  let harness: IntegrationHarness | null = null

  const harnessExit = await Effect.runPromiseExit(createIntegrationHarness(harnessConfig))
  if (Exit.isFailure(harnessExit)) {
    const unavailable = findTemporalCliUnavailableError(harnessExit.cause)
    if (unavailable) {
      console.warn(`[worker-load] skipped: ${unavailable.message}`)
      return
    }
    throw harnessExit.cause
  }
  harness = harnessExit.value

  const setupExit = await Effect.runPromiseExit(harness.setup)
  if (Exit.isFailure(setupExit)) {
    const unavailable = findTemporalCliUnavailableError(setupExit.cause)
    if (unavailable) {
      console.warn(`[worker-load] skipped during setup: ${unavailable.message}`)
      return
    }
    throw setupExit.cause
  }

  try {
    const envOverrides = {
      ...loadConfig.metricEnv,
      TEMPORAL_WORKFLOW_CONCURRENCY: String(loadConfig.workflowConcurrencyTarget),
      TEMPORAL_ACTIVITY_CONCURRENCY: String(loadConfig.activityConcurrencyTarget),
      TEMPORAL_STICKY_SCHEDULING_ENABLED: '1',
    }

    const scenarioExit = await Effect.runPromiseExit(
      harness.runScenario(
        'worker-load-cli',
        () =>
          Effect.tryPromise(() =>
            runWorkerLoad({
              harness,
              address: harnessConfig.address ?? '127.0.0.1:7233',
              namespace: harnessConfig.namespace ?? 'default',
              loadConfig,
            }),
          ),
        { env: envOverrides },
      ),
    )
    if (Exit.isFailure(scenarioExit)) {
      const unavailable = findTemporalCliUnavailableError(scenarioExit.cause)
      if (unavailable) {
        console.warn(`[worker-load] skipped during scenario: ${unavailable.message}`)
        return
      }
      throw scenarioExit.cause
    }
    const result = scenarioExit.value

    renderSummary(result)
    console.info(`[worker-load] metrics written to ${loadConfig.metricsStreamPath}`)
    console.info(`[worker-load] summary written to ${loadConfig.metricsReportPath}`)
    console.info(`[worker-load] CLI log at ${harness.temporalCliLogPath}`)
  } finally {
    const teardownExit = await Effect.runPromiseExit(harness.teardown)
    if (Exit.isFailure(teardownExit)) {
      const unavailable = findTemporalCliUnavailableError(teardownExit.cause)
      if (unavailable) {
        console.warn(`[worker-load] teardown warning: ${unavailable.message}`)
        return
      }
      throw teardownExit.cause
    }
  }
}

const renderSummary = (result: Awaited<ReturnType<typeof runWorkerLoad>>) => {
  const workflowP95 = result.summary.workflowPollLatency?.p95 ?? 0
  const activityP95 = result.summary.activityPollLatency?.p95 ?? 0
  console.log('\nWorker load results:')
  console.table({
    workflows: result.stats.submitted,
    completed: result.stats.completed,
    peakConcurrent: result.stats.peakConcurrent,
    throughputPerSec: Number(result.summary.workflowThroughputPerSecond.toFixed(2)),
    stickyHitRatio: Number(result.summary.stickyHitRatio.toFixed(2)),
    workflowPollP95Ms: Math.round(workflowP95),
    activityPollP95Ms: Math.round(activityP95),
  })
}

const applyOverrides = (values: Record<string, string | boolean | undefined>) => {
  if (values.workflows) {
    process.env.TEMPORAL_LOAD_TEST_WORKFLOWS = String(values.workflows)
  }
  if (values['workflow-concurrency']) {
    process.env.TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY = String(values['workflow-concurrency'])
  }
  if (values['activity-concurrency']) {
    process.env.TEMPORAL_LOAD_TEST_ACTIVITY_CONCURRENCY = String(values['activity-concurrency'])
  }
  if (values.timeout) {
    process.env.TEMPORAL_LOAD_TEST_TIMEOUT_MS = String(values.timeout)
  }
}

const printHelp = () => {
  console.log(`Usage: bun scripts/run-worker-load.ts [options]

Options:
  --workflows <n>             Number of workflows to submit (default via env)
  --workflow-concurrency <n>  Workflow concurrency target
  --activity-concurrency <n>  Activity concurrency target
  --timeout <ms>              Overall workflow completion timeout in milliseconds
  --help                      Show this help text

Environment overrides:
  TEMPORAL_LOAD_TEST_WORKFLOWS, TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY,
  TEMPORAL_LOAD_TEST_ACTIVITY_CONCURRENCY, TEMPORAL_LOAD_TEST_TIMEOUT_MS,
  TEMPORAL_TEST_SERVER=1 to reuse an existing Temporal CLI dev server.
`)
}

await main()
