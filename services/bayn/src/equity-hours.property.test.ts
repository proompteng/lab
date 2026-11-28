import { expect, test } from 'bun:test'
import { DateTime, Result, Schema } from 'effect'
import fc from 'fast-check'

import { MarketCalendarResponseSchema } from './broker/alpaca/model'
import { normalizeMarketCalendarResult } from './broker/alpaca/normalizers'
import { equityClockSession, equityDataSession, equityFeatureSegmentStartMs } from './equity-hours'
import { canonicalHashV1Result } from './hash'
import { marketHoursAreCanonical, executionCloseRecoveryExpiry } from './market-hours'
import { IsoDateSchema } from './schemas'
import { checkProperty } from './testing/property-test-support'

// Independent pre-optimization oracle: full zoned date decomposition, not the new clock-only formatter.
const originalClockSession = (instant: string) => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(instant, { timeZone: 'America/New_York' }))
  const minute = parts.hour * 60 + parts.minute
  return minute < 480 || minute >= 1020 ? null : minute < 570 ? 'pre' : minute < 960 ? 'regular' : 'post'
}

test('property: clock-only formatting preserves the full zoned oracle across canonical dates and nanoseconds', () => {
  checkProperty(
    'equity-clock-zoned-equivalence',
    fc.property(
      fc.integer({
        min: Date.parse('0000-01-01T00:00:00.000Z'),
        max: Date.parse('9999-12-31T23:59:59.999Z'),
      }),
      fc.integer({ min: 0, max: 999999 }),
      (epoch, subMillisecond) => {
        const instant = new Date(epoch).toISOString()
        const nanos = `${instant.slice(0, -1)}${String(subMillisecond).padStart(6, '0')}Z`
        expect(equityClockSession(instant)).toBe(originalClockSession(instant))
        expect(equityClockSession(nanos)).toBe(originalClockSession(nanos))
      },
    ),
    2000,
  )
})

test('clock sessions preserve midnight, DST transitions and historical second-offset boundaries', () => {
  for (const day of ['1883-11-18', '2026-03-08', '2026-11-01']) {
    const midnight = Date.parse(`${day}T00:00:00.000Z`)
    for (let minute = 0; minute < 24 * 60; minute++) {
      for (const offset of [0, 59999]) {
        const instant = new Date(midnight + minute * 60000 + offset).toISOString()
        expect(equityClockSession(instant)).toBe(originalClockSession(instant))
      }
    }
  }
  for (const [day, utcOffset] of [
    ['2026-07-01', 4],
    ['2026-12-01', 5],
  ] as const) {
    const midnight = Date.parse(`${day}T00:00:00.000Z`) + utcOffset * 3600000
    expect(equityClockSession(new Date(midnight).toISOString())).toBeNull()
    for (const [minute, before, after] of [
      [480, null, 'pre'],
      [570, 'pre', 'regular'],
      [960, 'regular', 'post'],
      [1020, 'post', null],
    ] as const) {
      const boundary = midnight + minute * 60000
      expect(equityClockSession(new Date(boundary - 1).toISOString())).toBe(before)
      expect(equityClockSession(new Date(boundary).toISOString())).toBe(after)
      expect(equityClockSession(new Date(boundary + 1).toISOString())).toBe(after)
    }
  }
})

test('clock formatting retains Effect input parsing and zoned range refusals', () => {
  for (const instant of ['2026-10-23T13:30:00', '2026-10-23T19:00:00+05:30', 'Fri, 23 Oct 2026 13:30:00 GMT'])
    expect(equityClockSession(instant)).toBe(originalClockSession(instant))
  for (const instant of ['', 'invalid', '2026-13-42T99:99:99Z']) {
    expect(() => equityClockSession(instant)).toThrow()
    expect(() => originalClockSession(instant)).toThrow()
  }
  const minimum = -8640000000000000 + 12 * 3600000
  const maximum = 8640000000000000 - 14 * 3600000
  for (const epoch of [minimum, maximum]) {
    const instant = new Date(epoch).toISOString()
    expect(equityClockSession(instant)).toBe(originalClockSession(instant))
  }
  for (const epoch of [minimum - 1, maximum + 1]) {
    const instant = new Date(epoch).toISOString()
    expect(() => equityClockSession(instant)).toThrow(RangeError)
    expect(() => originalClockSession(instant)).toThrow(RangeError)
  }
})

const calendar = (date: string, close = '16:00', sessionClose = '2000') => {
  const day = Schema.decodeUnknownSync(IsoDateSchema)(date)
  const raw = Schema.decodeUnknownSync(MarketCalendarResponseSchema)([
    { date, open: '09:30', close, session_open: '0400', session_close: sessionClose },
  ])
  return Result.getOrThrow(normalizeMarketCalendarResult(raw, { start: day, end: day }))
}

test('property: recovery leases stay inside the verified broker session after IEX stops', () => {
  checkProperty(
    'equity-close-recovery',
    fc.property(fc.integer({ min: 0, max: 179 * 60 + 59 }), (seconds) => {
      const hours = calendar('2026-10-16')
      const observed = Date.parse('2026-10-16T21:00:00.000Z') + seconds * 1000
      const expires = executionCloseRecoveryExpiry(hours, new Date(observed).toISOString())
      expect(expires).not.toBeNull()
      expect(Date.parse(expires ?? '')).toBeGreaterThan(observed)
      expect(Date.parse(expires ?? '')).toBeLessThanOrEqual(observed + 180_000)
      expect(Date.parse(expires ?? '')).toBeLessThanOrEqual(Date.parse('2026-10-17T00:00:00.000Z'))
      expect(executionCloseRecoveryExpiry(hours, '2026-10-17T00:00:00.000Z')).toBeNull()
      expect(executionCloseRecoveryExpiry(hours, '2026-10-17T12:00:00.000Z')).toBeNull()
      expect(
        executionCloseRecoveryExpiry(calendar('2026-11-27', '13:00', '1700'), '2026-11-27T22:00:00.000Z'),
      ).toBeNull()
      expect(executionCloseRecoveryExpiry(calendar('2026-11-02'), '2026-11-03T00:59:59.000Z')).toBe(
        '2026-11-03T01:00:00.000Z',
      )
    }),
  )
})

test.each([
  ['2026-10-16', '2026-10-16T12:00:00.000Z', '2026-10-16T21:00:00.000Z'],
  ['2026-11-02', '2026-11-02T13:00:00.000Z', '2026-11-02T22:00:00.000Z'],
])('Basic equity hours retain actual provider bounds across DST: %s', (date, openAt, closeAt) => {
  const observed = calendar(date)
  expect(observed.sessions).toEqual([{ date, openAt, closeAt }])
  expect(observed.providerSessions).toHaveLength(1)
  expect(marketHoursAreCanonical(observed)).toBe(true)
  expect(observed.providerSessions[0]?.regularCloseAt).not.toBe(closeAt)
})

test('an early regular close retains Alpaca extended trading until the provider session ends', () => {
  const observed = calendar('2026-11-27', '13:00', '1700')
  expect(observed.sessions[0]).toEqual({
    date: '2026-11-27',
    openAt: '2026-11-27T13:00:00.000Z',
    closeAt: '2026-11-27T22:00:00.000Z',
  })
  expect(observed.providerSessions[0]?.regularCloseAt).toBe('2026-11-27T18:00:00.000Z')
})

test('missing provider hours and forged selected hours cannot authorize an equity session', () => {
  expect(
    Schema.decodeUnknownResult(MarketCalendarResponseSchema)([{ date: '2026-10-16', open: '09:30', close: '16:00' }])
      ._tag,
  ).toBe('Failure')
  const { normalizedResponseHash: _hash, ...original } = calendar('2026-10-16')
  const material = {
    ...original,
    sessions: [
      { date: original.sessions[0]?.date, openAt: '2026-10-16T08:00:00.000Z', closeAt: '2026-10-16T21:00:00.000Z' },
    ],
  }
  expect(
    marketHoursAreCanonical({
      ...original,
      sessions: [{ ...original.sessions[0]!, openAt: material.sessions[0]!.openAt }],
      normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(material)),
    }),
  ).toBe(false)
})

test('first completed minutes reset computation at 08:00, 09:30 and 16:00 without a thirty-minute admission delay', () => {
  for (const [instant, phase, segment] of [
    ['2026-10-16T12:00:00.000Z', 'pre', '2026-10-16T12:00:00.000Z'],
    ['2026-10-16T13:30:00.000Z', 'regular', '2026-10-16T13:30:00.000Z'],
    ['2026-10-16T20:00:00.000Z', 'post', '2026-10-16T20:00:00.000Z'],
  ] as const) {
    expect(equityClockSession(instant)).toBe(phase)
    expect(equityFeatureSegmentStartMs(Date.parse(instant))).toBe(Date.parse(segment))
  }
  expect(equityClockSession('2026-10-16T11:59:59.999Z')).toBeNull()
  expect(equityClockSession('2026-10-16T21:00:00.000Z')).toBeNull()
})

test('property: provider intervals intersect the entitled data interval and preserve every boundary', () => {
  checkProperty(
    'equity-entitled-session-intersection',
    fc.property(
      fc.integer({ min: 0, max: 480 }),
      fc.integer({ min: 960, max: 1200 }),
      (providerOpen, providerClose) => {
        const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 4, minute)).toISOString()
        const source = {
          date: '2026-10-16',
          regularOpenAt: at(570),
          regularCloseAt: at(960),
          sessionOpenAt: at(providerOpen),
          sessionCloseAt: at(providerClose),
        }
        const selected = Result.getOrThrow(equityDataSession(source))
        expect(selected.openAt).toBe(at(480))
        expect(selected.closeAt).toBe(at(Math.min(1020, providerClose)))
        expect(selected.openAt >= source.sessionOpenAt && selected.closeAt <= source.sessionCloseAt).toBe(true)
      },
    ),
  )
})
