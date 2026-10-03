import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { canonicalHashV1 } from '../hash'
import { nativeJevFixture } from '../jev/native.test-support'
import {
  matchedEntryDefinition,
  matchedCalendarSessions,
  matchedObservationMaterial,
  MatchedDataRole,
  MatchedRecommendation,
  summarizeMatchedPairs,
  type MatchedPair,
  type MatchedRegistration,
} from './matched-entry-study'

const registration: MatchedRegistration = {
  schemaVersion: 'bayn.matched-entry-registration.v1',
  definitionHash: canonicalHashV1(matchedEntryDefinition),
  sourceRevision: 'a'.repeat(40),
  protocolHash: 'b'.repeat(64),
  registeredAt: '2026-09-03T00:00:00.000Z',
  dataRole: MatchedDataRole.Prospective,
  sessionDates: ['2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'],
  latencyMs: 100,
  executionAssumptionsHash: 'e'.repeat(64),
  latencyEvidenceHash: 'c'.repeat(64),
  capacityEvidenceHash: 'd'.repeat(64),
}
const outcome = (net: string): NonNullable<MatchedPair['jev']> => ({
  status: 'RESOLVED',
  netExecutionPnlMicros: net,
  episodes: [],
  orders: [],
  quoteHashes: [],
  problems: [],
  fills: ['buy', 'sell'].map((side) => ({
    symbol: 'AAPL',
    side: side === 'buy' ? ('buy' as const) : ('sell' as const),
    observedAt: '2026-09-04T14:00:00.000Z',
    quantityMicros: '100000000',
    priceMicros: '100000000',
    notionalMicros: '10000000000',
  })),
})
const pairs = (override: Partial<MatchedPair> = {}): MatchedPair[] =>
  Array.from({ length: 20 }, (_, n) => ({
    batchId: canonicalHashV1({ n }),
    sessionDate: registration.sessionDates[n % 5] ?? '',
    jevSymbol: 'AAPL',
    momentumSymbol: null,
    modelAvailable: true,
    jev: outcome('30000000'),
    momentum: null,
    inferenceCostMicros: '100000',
    sharedOperatingCostMicros: '100000',
    ...override,
  }))

type SessionDate = MatchedRegistration['sessionDates'][number]
const calendar = (dates: readonly SessionDate[], start: SessionDate, end: SessionDate, close = '16:00') =>
  Result.getOrThrow(
    normalizeMarketCalendarResult(
      dates.map((date) => ({ date, open: '09:30', close })),
      { start, end },
    ),
  )
const fullCalendar = calendar(registration.sessionDates, '2026-09-04', '2026-09-11')
const laterCalendar = calendar(registration.sessionDates.slice(1), '2026-09-08', '2026-09-11')

test('retained calendars accept unordered batches and deduplicate agreeing session dates', () => {
  const chronological = Result.getOrThrow(matchedCalendarSessions(registration, [fullCalendar, laterCalendar]))
  expect(
    Result.getOrThrow(matchedCalendarSessions(registration, [laterCalendar, fullCalendar, laterCalendar])),
  ).toEqual(chronological)
  expect(chronological.map((session) => session.date)).toEqual([...registration.sessionDates])
})

test('conflicting calendar sessions and duplicate registered dates cannot form a schedule', () => {
  const changedClose = calendar(registration.sessionDates.slice(1), '2026-09-08', '2026-09-11', '13:00')
  expect(Result.isFailure(matchedCalendarSessions(registration, [fullCalendar, changedClose]))).toBeTrue()
  const omitted = calendar(['2026-09-08', '2026-09-10', '2026-09-11'], '2026-09-08', '2026-09-11')
  expect(Result.isFailure(matchedCalendarSessions(registration, [fullCalendar, omitted]))).toBeTrue()
  expect(
    Result.isFailure(
      matchedCalendarSessions(
        { ...registration, sessionDates: ['2026-09-04', '2026-09-04', '2026-09-09', '2026-09-10', '2026-09-11'] },
        [fullCalendar],
      ),
    ),
  ).toBeTrue()
})

test('earliest registered session and every calendar date between sessions need retained coverage', () => {
  expect(Result.isFailure(matchedCalendarSessions(registration, [laterCalendar]))).toBeTrue()
  const firstOnly = calendar(['2026-09-04'], '2026-09-04', '2026-09-04')
  expect(Result.isFailure(matchedCalendarSessions(registration, [firstOnly, laterCalendar]))).toBeTrue()
  const firstWithHoliday = calendar(['2026-09-04'], '2026-09-04', '2026-09-07')
  expect(Result.getOrThrow(matchedCalendarSessions(registration, [laterCalendar, firstWithHoliday]))).toEqual([
    ...fullCalendar.sessions,
  ])
  const extraSession = calendar(
    ['2026-09-04', '2026-09-07', ...registration.sessionDates.slice(1)],
    '2026-09-04',
    '2026-09-11',
  )
  expect(Result.isFailure(matchedCalendarSessions(registration, [extraSession]))).toBeTrue()
})

test('prospective registration always uses the earliest registered open regardless of batch ordering', () => {
  expect(
    Result.isFailure(
      matchedCalendarSessions({ ...registration, registeredAt: '2026-09-04T13:30:00.000Z' }, [
        laterCalendar,
        fullCalendar,
      ]),
    ),
  ).toBeTrue()
  expect(
    Result.isSuccess(
      matchedCalendarSessions({ ...registration, registeredAt: '2026-09-04T13:29:59.999Z' }, [
        laterCalendar,
        fullCalendar,
      ]),
    ),
  ).toBeTrue()
})

test('abstentions retain denominator and inference costs; identical picks share execution increment', () => {
  const report = summarizeMatchedPairs(registration, [...pairs(), ...pairs({ jevSymbol: null, jev: null })], [])
  expect(report.opportunityCount).toBe(40)
  expect(report.means.incrementalBudgetReturnBps).toBe(14.9)
  expect(report.paired[20]?.incrementalMicros).toBe('-100000')
  const identical = summarizeMatchedPairs(
    registration,
    [...pairs(), ...pairs({ momentumSymbol: 'AAPL', momentum: outcome('30000000') })],
    [],
  )
  expect(identical.paired[20]?.incrementalMicros).toBe('-100000')
  expect(identical.paired[20]?.stressedIncrementalMicros).toBe('-100000')
})

test.each([
  { inferenceCostMicros: null },
  { sharedOperatingCostMicros: null },
  { modelAvailable: false },
  { jev: { ...outcome('30000000'), status: 'UNRESOLVED' as const, netExecutionPnlMicros: null } },
])('unknown evidence blocks all headline means without dropping labels', (override) => {
  const report = summarizeMatchedPairs(registration, [...pairs(), ...pairs(override)], [])
  expect(report.completion).toBe('INCOMPLETE')
  expect(report.recommendation).toBe(MatchedRecommendation.Inconclusive)
  expect(Object.values(report.means).every((value) => value === null)).toBeTrue()
  expect(report.opportunityCount).toBe(40)
})

test('stress failure stops, prospective positive only earns portfolio test, historical remains development', () => {
  const failed = summarizeMatchedPairs(registration, pairs({ jev: outcome('10000000') }), [])
  expect(failed.means.incrementalBudgetReturnBps).toBeGreaterThan(0)
  expect(failed.means.stressedIncrementalBudgetReturnBps).toBeLessThan(0)
  expect(failed.recommendation).toBe(MatchedRecommendation.Stop)
  expect(summarizeMatchedPairs(registration, pairs(), []).recommendation).toBe(MatchedRecommendation.TestPortfolio)
  expect(
    summarizeMatchedPairs({ ...registration, dataRole: MatchedDataRole.Development }, pairs(), []).recommendation,
  ).toBe(MatchedRecommendation.DevelopmentOnly)
})

test('sparse selections, omitted inventory and missing calibration remain inconclusive', () => {
  expect(summarizeMatchedPairs(registration, pairs().slice(0, 19), []).recommendation).toBe(
    MatchedRecommendation.Inconclusive,
  )
  expect(
    summarizeMatchedPairs(registration, pairs(), ['entry-inventory-mismatch']).means.incrementalBudgetReturnBps,
  ).toBeNull()
  expect(summarizeMatchedPairs({ ...registration, latencyEvidenceHash: null }, pairs(), []).completion).toBe(
    'INCOMPLETE',
  )
})

test('source comparison preserves nanoseconds and accepts equivalent timestamp spellings', () => {
  const snapshot = nativeJevFixture().snapshot
  const hash = canonicalHashV1(matchedObservationMaterial(snapshot))
  const padded = {
    ...snapshot,
    quotes: snapshot.quotes.map((q) => ({
      ...q,
      eventAt: q.eventAt.replace('.000Z', '.000000000Z'),
      ingestedAt: q.ingestedAt.replace('.000Z', '.000000000Z'),
    })),
  }
  expect(canonicalHashV1(matchedObservationMaterial(padded))).toBe(hash)
  const changed = {
    ...padded,
    quotes: padded.quotes.map((q, n) =>
      n === 0 ? { ...q, eventAt: q.eventAt.replace('.000000000Z', '.000000001Z') } : q,
    ),
  }
  expect(canonicalHashV1(matchedObservationMaterial(changed))).not.toBe(hash)
})
