import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { createLogger, type LogRecord, type LoggerSink } from '../../src/observability/logger'
import { makeInMemoryMetrics } from '../../src/observability/metrics'
import { createIntegrationHarness } from './harness'

const createCaptureLogger = () => {
  const records: LogRecord[] = []
  const sink: LoggerSink = {
    write(record) {
      records.push(record)
      return Effect.void
    },
  }

  const logger = createLogger({
    level: 'debug',
    sinks: [sink],
  })

  return { logger, records }
}

test('integration harness records logs and metrics for scenarios', async () => {
  const { logger, records } = createCaptureLogger()
  const metrics = await Effect.runPromise(makeInMemoryMetrics())

  const harness = await Effect.runPromise(
    createIntegrationHarness(
      {
        address: '127.0.0.1:7233',
        namespace: 'default',
      },
      { logger, metrics },
    ),
  )

  await Effect.runPromise(harness.setup)

  const successResult = await Effect.runPromise(
    harness.runScenario('success-case', () => Effect.succeed('ok')),
  )
  expect(successResult).toBe('ok')

  await expect(
    Effect.runPromise(harness.runScenario('failing-case', () => Effect.fail(new Error('boom')))),
  ).rejects.toThrow('boom')

  await Effect.runPromise(harness.teardown)

  const snapshot = await Effect.runPromise(harness.metrics.collect!())
  const scenariosMetric = snapshot.counters.find((counter) => counter.name === 'temporal_integration_scenarios_total')
  expect(scenariosMetric?.points).toBeDefined()
  const successPoint = scenariosMetric?.points?.find((point) => point.attributes.scenario === 'success-case')
  const failureScenarioPoint = scenariosMetric?.points?.find((point) => point.attributes.scenario === 'failing-case')
  expect(successPoint?.value).toBe(1)
  expect(failureScenarioPoint?.value).toBe(1)

  const failureMetric = snapshot.counters.find((counter) => counter.name === 'temporal_integration_failures_total')
  const failurePoint = failureMetric?.points?.find((point) => point.attributes.scenario === 'failing-case')
  expect(failurePoint?.value).toBe(1)

  const labels = records.map((record) => record.message)
  expect(labels).toContain('integration harness setup')
  expect(labels).toContain('integration harness teardown')
  expect(labels).toContain('integration scenario start')
  expect(labels).toContain('integration scenario completed')
  expect(labels).toContain('integration scenario failed')
})
