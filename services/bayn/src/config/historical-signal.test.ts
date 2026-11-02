import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Option, Result } from 'effect'

import { historicalSignalConfig } from '../testing/historical-signal-fixture'
import { loadHistoricalSignalConfig, loadOptionalHistoricalSignalConfig } from './historical-signal'

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

const load = (values: Record<string, string>, optional = false) =>
  Effect.runPromise(
    Effect.result(
      (optional
        ? loadOptionalHistoricalSignalConfig.pipe(Effect.map(Option.getOrUndefined))
        : loadHistoricalSignalConfig
      ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values))),
    ),
  )

describe('explicit historical Signal configuration', () => {
  test('native reporting permits complete absence without fabricating a snapshot', async () => {
    expect(Result.getOrThrow(await load({}, true))).toBeUndefined()
    expect(Result.isFailure(await load({}))).toBe(true)
    expect(Result.getOrThrow(await load(environment, true))).toEqual(historicalSignalConfig)
  })

  test.each(Object.entries(environment))(
    'a lone %s is incomplete, not an absent legacy snapshot',
    async (name, value) => {
      expect(await load({ [name]: value }, true)).toMatchObject({
        _tag: 'Failure',
        failure: { component: 'config', operation: 'historical-signal', retryable: false },
      })
    },
  )

  test('retains every supplied immutable snapshot and evaluation input', async () => {
    expect(Result.getOrThrow(await load(environment))).toEqual(historicalSignalConfig)
  })

  test.each(Object.keys(environment))('requires %s without a fallback', async (name) => {
    const values: Record<string, string> = { ...environment }
    delete values[name]
    const result = await load(values)
    expect(Result.isFailure(await load(values, true))).toBe(true)
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
    expect(Result.isFailure(await load({ ...environment, [name]: value }, true))).toBe(true)
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
    expect(Result.isFailure(await load({ ...environment, ...invalid }, true))).toBe(true)
  })
})
