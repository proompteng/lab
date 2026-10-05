import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Result } from 'effect'

import { historicalSignalConfig } from '../testing/historical-signal-fixture'
import { loadHistoricalSignalConfig } from './historical-signal'

const environment = {
  BAYN_SIGNAL_SNAPSHOT_ID: historicalSignalConfig.snapshotId,
  BAYN_SIGNAL_PUBLICATION_ASOF: historicalSignalConfig.publicationAsOf,
  BAYN_SIGNAL_CALENDAR_VERSION: historicalSignalConfig.calendarVersion,
  BAYN_SIGNAL_DATA_START: historicalSignalConfig.bounds.dataStart,
  BAYN_SIGNAL_DATA_END: historicalSignalConfig.bounds.dataEnd,
  BAYN_SIGNAL_LOOKBACK_START: historicalSignalConfig.bounds.lookbackStart,
  BAYN_SIGNAL_EVALUATION_START: historicalSignalConfig.bounds.evaluationStart,
  BAYN_SIGNAL_EVALUATION_END: historicalSignalConfig.bounds.evaluationEnd,
}

const load = (values: Record<string, string>) =>
  Effect.runPromise(
    Effect.result(
      loadHistoricalSignalConfig.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
      ),
    ),
  )

describe('explicit historical Signal configuration', () => {
  test('retains every supplied immutable snapshot and evaluation input', async () => {
    expect(Result.getOrThrow(await load(environment))).toEqual(historicalSignalConfig)
  })

  test.each(Object.keys(environment))('requires %s without a fallback', async (name) => {
    const values: Record<string, string> = { ...environment }
    delete values[name]
    const result = await load(values)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ component: 'config', operation: 'historical-signal', retryable: false })
      expect(result.failure.message).toContain('all eight valid BAYN_SIGNAL_*')
      expect(JSON.stringify(result.failure.cause)).toContain(name)
    }
  })

  test.each([
    ['BAYN_SIGNAL_SNAPSHOT_ID', 'not-a-snapshot-hash'],
    ['BAYN_SIGNAL_PUBLICATION_ASOF', 'not-a-date'],
    ['BAYN_SIGNAL_CALENDAR_VERSION', '   '],
    ['BAYN_SIGNAL_DATA_START', 'not-a-date'],
    ['BAYN_SIGNAL_DATA_END', 'not-a-date'],
    ['BAYN_SIGNAL_LOOKBACK_START', 'not-a-date'],
    ['BAYN_SIGNAL_EVALUATION_START', 'not-a-date'],
    ['BAYN_SIGNAL_EVALUATION_END', 'not-a-date'],
  ])('rejects malformed %s', async (name, value) => {
    expect(Result.isFailure(await load({ ...environment, [name]: value }))).toBe(true)
  })

  test.each([
    { BAYN_SIGNAL_PUBLICATION_ASOF: '2026-02-30' },
    { BAYN_SIGNAL_DATA_START: '2026-08-29' },
    { BAYN_SIGNAL_DATA_END: '2026-08-27' },
    { BAYN_SIGNAL_LOOKBACK_START: '2026-08-29' },
    { BAYN_SIGNAL_EVALUATION_START: '2026-08-29' },
    { BAYN_SIGNAL_EVALUATION_END: '2016-01-01' },
  ])('rejects impossible dates or inconsistent historical bounds: %j', async (invalid) => {
    expect(Result.isFailure(await load({ ...environment, ...invalid }))).toBe(true)
  })
})
