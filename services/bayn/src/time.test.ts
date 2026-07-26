import { describe, expect, test } from 'bun:test'

import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import {
  addUtcDays,
  currentUtcDate,
  currentUtcInstant,
  utcDateFromEpochMillis,
  utcInstantFromEpochMillis,
} from './time'

describe('Bayn UTC clock boundary', () => {
  test('formats epoch milliseconds with the existing canonical UTC wire contract', () => {
    const epochMillis = Date.parse('2026-07-26T06:23:57.295Z')

    expect(utcInstantFromEpochMillis(epochMillis)).toBe('2026-07-26T06:23:57.295Z')
    expect(utcDateFromEpochMillis(epochMillis)).toBe('2026-07-26')
    expect(addUtcDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  test('samples the injected Effect clock for instant and date projections', async () => {
    const [instant, date] = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-07-26T06:23:57.295Z'))
        return yield* Effect.all([currentUtcInstant, currentUtcDate])
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(instant).toBe('2026-07-26T06:23:57.295Z')
    expect(date).toBe('2026-07-26')
  })
})
