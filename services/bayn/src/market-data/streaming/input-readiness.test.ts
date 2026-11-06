import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { snapshotReadiness } from '../../cycle/runner/readiness'
import { decodeInputReadiness, InputReadinessReason } from '../intraday/input-readiness'
import { MarketFeatureDefinition } from '../features/contract'
import { isCryptoMarketFeature } from '../features/crypto-contract'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { compactStreamingProjection } from './query-cut'
import { constructStreamingSnapshot } from './snapshot'

test('partial exclusion retains successful candidates and source bytes through compaction', () => {
  const { cut, query } = streamingFixture(undefined, false)
  const features = new Map(cut.projection.features)
  features.delete('AAPL')
  const partial = { ...cut, projection: { ...cut.projection, features } }
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(partial, query))
  expect(snapshot.manifest.candidateExclusions?.some((entry) => entry.symbol === 'AAPL')).toBe(true)
  const compact = Result.getOrThrow(compactStreamingProjection(partial, query))
  expect(Result.getOrThrow(constructStreamingSnapshot({ ...partial, projection: compact }, query))).toEqual(snapshot)
})

test('input readiness bounds counts, rejects premature windows and strips arbitrary fields', () => {
  const valid = {
    reason: InputReadinessReason.AllCandidatesExcluded,
    observedAt: '2026-09-04T14:30:02.000Z',
    windowStartAt: '2026-09-04T14:00:00.000Z',
    windowEndAt: '2026-09-04T14:30:00.000Z',
    requiredFeatureDefinition: MarketFeatureDefinition.ObservedPriceWindow,
    candidateCount: 15,
    matchingFeatureCandidateCount: 0,
    completedBarCandidateCount: 15,
  }
  expect(decodeInputReadiness({ ...valid, rawPayload: 'private', message: 'private' })).toEqual(valid)
  for (const patch of [
    { candidateCount: 0 },
    { candidateCount: Number.POSITIVE_INFINITY },
    { candidateCount: Number.MAX_SAFE_INTEGER + 1 },
    { matchingFeatureCandidateCount: 16 },
    { completedBarCandidateCount: -1 },
    { completedBarCandidateCount: 0.5 },
    { reason: 'private-error' },
    { observedAt: valid.windowStartAt },
    { windowStartAt: valid.windowEndAt },
  ])
    expect(decodeInputReadiness({ ...valid, ...patch })).toBeUndefined()
})

test.each(['absent', 'late', 'wrong-window', 'missing-completed-bar', 'late-completed-bar', 'missing-quote'])(
  'all-candidate rejection reports observed-cut counts for %s evidence',
  (scenario) => {
    const { cut, query } = streamingFixture(undefined, false)
    const features = new Map(
      [...cut.projection.features].map(([symbol, history]) => [
        symbol,
        scenario === 'absent'
          ? []
          : history.map((entry) => ({
              ...entry,
              availableAtMs: scenario === 'late' ? Date.parse(query.observedAt) + 1 : entry.availableAtMs,
              value:
                scenario === 'wrong-window' && !isCryptoMarketFeature(entry.value)
                  ? {
                      ...entry.value,
                      material: { ...entry.value.material, windowEndMs: Date.parse(query.rangeEndAt) - 60_000 },
                    }
                  : entry.value,
            })),
      ]),
    )
    const bars = new Map(
      [...cut.projection.bars].map(([symbol, history]) => [
        symbol,
        scenario === 'missing-completed-bar'
          ? history.filter((entry) => Date.parse(entry.value.eventAt) !== Date.parse(query.rangeEndAt) - 60_000)
          : scenario === 'late-completed-bar'
            ? history.map((entry) =>
                Date.parse(entry.value.eventAt) === Date.parse(query.rangeEndAt) - 60_000
                  ? { ...entry, availableAtMs: Date.parse(query.observedAt) + 1 }
                  : entry,
              )
            : history,
      ]),
    )
    const rejectedCut = {
      ...cut,
      projection: {
        ...cut.projection,
        features,
        bars,
        ...(scenario === 'missing-quote' ? { quoteHistory: new Map(), quotes: new Map() } : {}),
      },
    }
    const result = constructStreamingSnapshot(rejectedCut, query)
    if (Result.isSuccess(result)) throw new Error('Unavailable candidate inputs must reject the snapshot')
    const diagnostic = {
      reason: 'ALL_CANDIDATES_EXCLUDED',
      observedAt: query.observedAt,
      windowStartAt: query.rangeStartAt,
      windowEndAt: query.rangeEndAt,
      candidateCount: query.candidateSymbols?.length,
      matchingFeatureCandidateCount: scenario === 'missing-quote' ? query.candidateSymbols?.length : 0,
      completedBarCandidateCount: ['missing-completed-bar', 'late-completed-bar'].includes(scenario)
        ? 0
        : query.candidateSymbols?.length,
    }
    expect(result.failure.facts?.['inputReadiness']).toMatchObject(diagnostic)
    expect(snapshotReadiness(result.failure)).toMatchObject({ inputReadiness: diagnostic })
    const compact = Result.getOrThrow(compactStreamingProjection(rejectedCut, query))
    const repeated = constructStreamingSnapshot({ ...rejectedCut, projection: compact }, query)
    if (Result.isSuccess(repeated)) throw new Error('Compaction cannot admit unavailable inputs')
    expect(repeated.failure.facts).toEqual(result.failure.facts)
  },
)
