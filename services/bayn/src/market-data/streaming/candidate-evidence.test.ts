import { snapshotFailureMeasurement } from './telemetry'
import { jevRequestForSnapshot } from '../../jev/native.test-support'
import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { jevStalePricingSymbols } from '../../jev/trading-signals'
import { streamingFixture, streamingFixtureFromRaw } from '../../testing/streaming-market-fixture'
import { IntradayCandidateEvidencePolicy, IntradaySnapshotPurpose } from '../intraday/model'
import { latestQuotes, persistIntradayRecordRows, verifyIntradaySnapshotQuery } from '../intraday/verification'
import { constructSimulatedSnapshot, constructStreamingSnapshot } from './snapshot'
import { reproduceSimulatedSnapshot, reproduceStreamingSnapshot } from './replay'
import { simulationFixture } from '../../testing/simulated-streaming-fixture'
import { diagnoseStreamingInputs } from './inputs'

const fixture = streamingFixture()
const query = {
  ...fixture.query,
  candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
  maximumQuoteAgeMs: 10_000,
}
const withTimes = (symbol: string, quoteAt: string, tradeAt: string) => ({
  ...fixture.archive,
  quotes: fixture.archive.quotes.map((quote) =>
    quote.symbol === symbol ? { ...quote, eventAt: quoteAt, ingestedAt: quoteAt } : quote,
  ),
  trades: fixture.archive.trades.map((trade) =>
    trade.symbol === symbol ? { ...trade, eventAt: tradeAt, ingestedAt: tradeAt } : trade,
  ),
})
const exclusion = (snapshot: import('./snapshot').StreamingVerifiedMarketSnapshot) =>
  snapshot.manifest.candidateExclusions?.find((entry) => entry.symbol === 'AAPL')
const replay = (snapshot: import('./snapshot').StreamingVerifiedMarketSnapshot) =>
  Result.getOrThrow(
    reproduceStreamingSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
  )

describe('candidate executable quote and window trade evidence', () => {
  test('diagnostics retain decision-time holes after a later bar arrives', () => {
    const missingAt = '2026-09-04T14:10:00.000Z'
    const bars = new Map(fixture.cut.projection.bars)
    bars.set(
      'AAPL',
      (bars.get('AAPL') ?? []).map((entry) =>
        entry.value.eventAt === missingAt ? { ...entry, availableAtMs: Date.parse(query.observedAt) + 1 } : entry,
      ),
    )
    const diagnosed = Result.getOrThrow(diagnoseStreamingInputs({ ...fixture.cut.projection, bars }, query))
    expect(diagnosed.candidates.find((entry) => entry.symbol === 'AAPL')).toMatchObject({
      eligibility: { status: 'EXCLUDED', reason: 'not-ready' },
      window: { requiredBarCount: 30, observedBarCount: 29, missingBarAt: [missingAt] },
      quote: { ageMs: 1000, sourceTopic: query.sourceTopics.quotes },
    })
  })

  test('diagnostics preserve the full excluded inventory when no candidate is ready', () => {
    const state = {
      ...fixture.cut.projection,
      features: new Map([...fixture.cut.projection.features].filter(([symbol]) => symbol === 'SPY')),
    }
    const diagnosed = Result.getOrThrow(diagnoseStreamingInputs(state, query))
    expect(diagnosed.candidates).toHaveLength(query.candidateSymbols?.length ?? 0)
    expect(diagnosed.candidates.every((entry) => entry.eligibility.status === 'EXCLUDED')).toBe(true)
    expect(Result.isFailure(constructStreamingSnapshot({ ...fixture.cut, projection: state }, query))).toBe(true)
  })

  test('uses a current quote with an older real window trade and exposes its actual age to Jev', () => {
    const { snapshot } = streamingFixtureFromRaw(
      withTimes('AAPL', '2026-09-04T14:30:01.000Z', '2026-09-04T14:20:00.000Z'),
      query,
    )
    expect(exclusion(snapshot)).toBeUndefined()
    expect(jevStalePricingSymbols(snapshot)).not.toContain('AAPL')
    const state = JSON.parse(Result.getOrThrow(jevRequestForSnapshot(snapshot, 'AAPL')).body).state
    expect(state.candidate.quote.ageMs).toBe(1000)
    expect(state.candidate.latestTrade.ageMs).toBe(602_000)
    expect(state.units.latestTrade).toContain('not an executable price')
    expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
  })

  test('accepts a fresh quote before the completed bar boundary without a post-range trade', () => {
    const { snapshot } = streamingFixtureFromRaw(
      withTimes('AAPL', '2026-09-04T14:29:59.000Z', '2026-09-04T14:29:00.000Z'),
      query,
    )
    expect(exclusion(snapshot)).toBeUndefined()
    expect(Result.isSuccess(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
    expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
  })

  test('retains verified features for rejected candidates without admitting their stale quotes', () => {
    const { snapshot } = streamingFixtureFromRaw(
      withTimes('AAPL', '2026-09-04T14:29:51.999Z', '2026-09-04T14:20:00.000Z'),
      query,
    )
    expect(exclusion(snapshot)?.reason).toBe('freshness')
    expect(snapshot.manifest.streaming.features.some((receipt) => receipt.value.material.symbol === 'AAPL')).toBe(true)
    expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
    expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
  })

  test.each(['2026-09-04T14:10:00.000Z', '2026-09-04T14:29:00.000Z'])(
    'persists and replays the exact missing bar at %s',
    (missingAt) => {
      const { snapshot } = streamingFixtureFromRaw(
        {
          ...fixture.archive,
          bars: fixture.archive.bars.filter((bar) => bar.symbol !== 'AAPL' || bar.eventAt !== missingAt),
        },
        query,
      )
      if (missingAt === '2026-09-04T14:29:00.000Z') {
        expect(exclusion(snapshot)?.reason).toBe('not-ready')
        expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
      } else {
        expect(exclusion(snapshot)).toBeUndefined()
        expect(Result.isSuccess(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
        expect(snapshot.bars.filter((bar) => bar.symbol === 'AAPL')).toHaveLength(29)
      }
      expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
    },
  )

  test('rejects missing range completion while retaining late historical evidence', () => {
    const { snapshot } = streamingFixtureFromRaw(
      {
        ...fixture.archive,
        bars: fixture.archive.bars
          .filter((bar) => bar.symbol !== 'AAPL' || bar.eventAt !== '2026-09-04T14:29:00.000Z')
          .map((bar) =>
            bar.symbol === 'AAPL' && bar.eventAt === '2026-09-04T14:10:00.000Z'
              ? { ...bar, ingestedAt: '2026-09-04T14:30:01.000Z' }
              : bar,
          ),
      },
      query,
    )
    expect(exclusion(snapshot)?.reason).toBe('not-ready')
    expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
    expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
  })

  test('distinguishes a complete raw window with no observed matching feature', () => {
    const features = new Map(fixture.cut.projection.features)
    features.delete('AAPL')
    const snapshot = Result.getOrThrow(
      constructStreamingSnapshot(
        {
          ...fixture.cut,
          projection: { ...fixture.cut.projection, features },
        },
        query,
      ),
    )
    expect(exclusion(snapshot)?.message).toBe('no observed rolling feature matches the complete bar window')
    expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
    expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
  })

  test('keeps absent and out-of-window trades excluded instead of substituting a quote or bar price', () => {
    for (const trades of [
      [],
      fixture.archive.trades
        .filter((trade) => trade.symbol === 'AAPL')
        .map((trade) => ({
          ...trade,
          eventAt: '2026-09-04T13:59:59.000Z',
          ingestedAt: '2026-09-04T13:59:59.000Z',
        })),
    ]) {
      const { snapshot } = streamingFixtureFromRaw(
        {
          ...fixture.archive,
          trades: [...fixture.archive.trades.filter((trade) => trade.symbol !== 'AAPL'), ...trades],
        },
        query,
      )
      expect(exclusion(snapshot)?.message).toBe('intraday snapshot lacks a trade for candidate symbol')
      expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
    }
  })

  test('rejects delayed arrival of an old trade even when the candidate quote is current', () => {
    const raw = withTimes('AAPL', '2026-09-04T14:30:01.000Z', '2026-09-04T14:20:00.000Z')
    const { snapshot } = streamingFixtureFromRaw(
      {
        ...raw,
        trades: raw.trades.map((trade) =>
          trade.symbol === 'AAPL' ? { ...trade, ingestedAt: '2026-09-04T14:30:01.000Z' } : trade,
        ),
      },
      query,
    )
    expect(exclusion(snapshot)?.reason).toBe('freshness')
    expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
  })

  test('keeps required benchmark post-range evidence strict', () => {
    expect(() =>
      streamingFixtureFromRaw(withTimes('SPY', '2026-09-04T14:30:01.000Z', '2026-09-04T14:20:00.000Z'), query),
    ).toThrow('post-range trade')
    expect(() =>
      streamingFixtureFromRaw(withTimes('SPY', '2026-09-04T14:29:59.000Z', '2026-09-04T14:30:01.000Z'), query),
    ).toThrow('post-range quote')
  })

  test('reproduces historical cuts under their original evidence contract', () => {
    const { snapshot } = streamingFixtureFromRaw(
      withTimes('AAPL', '2026-09-04T14:30:01.000Z', '2026-09-04T14:20:00.000Z'),
      fixture.query,
    )
    expect(exclusion(snapshot)?.message).toBe('intraday snapshot lacks a post-range trade for every symbol')
    expect(snapshot.manifest.streaming.features.some((receipt) => receipt.value.material.symbol === 'AAPL')).toBe(false)
    expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
  })

  test('enforces the exact quote-age boundary independently of the older contextual trade', () => {
    for (const [quoteAt, allowed] of [
      ['2026-09-04T14:29:52.000Z', true],
      ['2026-09-04T14:29:51.999999999Z', false],
    ] as const) {
      const { snapshot } = streamingFixtureFromRaw(withTimes('AAPL', quoteAt, '2026-09-04T14:20:00.000Z'), query)
      expect(exclusion(snapshot) === undefined).toBe(allowed)
      expect(Result.isSuccess(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(allowed)
    }
  })

  test('rejects future-dated signal prices within the producer clock allowance', () => {
    for (const [quoteAt, tradeAt] of [
      ['2026-09-04T14:30:02.001Z', '2026-09-04T14:20:00.000Z'],
      ['2026-09-04T14:30:01.000Z', '2026-09-04T14:30:02.001Z'],
    ] as const) {
      const { snapshot } = streamingFixtureFromRaw(withTimes('AAPL', quoteAt, tradeAt), query)
      expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
    }
  })

  test('does not admit a feature received after observation, even for a complete window', () => {
    const features = new Map(fixture.cut.projection.features)
    features.set(
      'AAPL',
      (features.get('AAPL') ?? []).map((receipt) => ({
        ...receipt,
        availableAtMs: Date.parse(query.observedAt) + 1,
      })),
    )
    const snapshot = Result.getOrThrow(
      constructStreamingSnapshot(
        {
          ...fixture.cut,
          projection: { ...fixture.cut.projection, features },
        },
        query,
      ),
    )
    expect(exclusion(snapshot)?.message).toBe('no observed rolling feature matches the complete bar window')
    expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
  })

  test('keeps the evidence policy out of quote-only pricing and binds it to replay identity', () => {
    expect(
      Result.isFailure(verifyIntradaySnapshotQuery({ ...query, purpose: IntradaySnapshotPurpose.EntryPricing })),
    ).toBe(true)
    const { candidateSymbols: _candidates, ...withoutCandidates } = query
    expect(Result.isFailure(verifyIntradaySnapshotQuery(withoutCandidates))).toBe(true)
    const { snapshot } = streamingFixtureFromRaw(fixture.archive, query)
    const { candidateEvidencePolicy: _policy, ...changed } = snapshot.manifest
    expect(
      Result.isFailure(reproduceStreamingSnapshot(changed, Result.getOrThrow(persistIntradayRecordRows(snapshot)))),
    ).toBe(true)
  })

  test('reproduces the same candidate policy through simulated evidence', () => {
    const simulation = simulationFixture()
    const snapshot = Result.getOrThrow(
      constructSimulatedSnapshot(simulation.cursor, simulation.source, {
        ...simulation.query,
        candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
      }),
    )
    const restored = Result.getOrThrow(
      reproduceSimulatedSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
    )
    expect(restored.manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
    expect(Result.isSuccess(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
  })
})

test('the production rejection measurement preserves every excluded candidate and exact missing input', () => {
  const state = {
    ...fixture.cut.projection,
    features: new Map([...fixture.cut.projection.features].filter(([symbol]) => symbol === 'SPY')),
  }
  const result = constructStreamingSnapshot({ ...fixture.cut, projection: state }, query)
  if (Result.isSuccess(result)) throw new Error('All candidates without features must fail')
  const measured = snapshotFailureMeasurement(result.failure, query, state)
  expect(measured.candidateCoverage).toHaveLength(query.candidateSymbols?.length ?? 0)
  expect(
    measured.candidateCoverage?.every(
      (candidate) => candidate.eligibility.status === 'EXCLUDED' && candidate.matchingFeature === null,
    ),
  ).toBe(true)
  expect(measured.candidateCoverage?.find((candidate) => candidate.symbol === 'AAPL')).toMatchObject({
    eligibility: { status: 'EXCLUDED', reason: 'not-ready' },
    window: { requiredBarCount: 30, observedBarCount: 30, missingBarAt: [] },
    quote: { ageMs: 1000 },
  })
})

test.each(['bid', 'ask', 'both'] as const)(
  'a withdrawn %s side excludes only its candidate and supersedes the earlier executable quote',
  (side) => {
    const previous = fixture.archive.quotes.findLast((quote) => quote.symbol === 'AAPL')
    if (previous === undefined) throw new Error('Missing AAPL quote fixture')
    const withdrawn = {
      ...previous,
      eventAt: '2026-09-04T14:30:01.999Z',
      ingestedAt: '2026-09-04T14:30:01.999Z',
      sourceOffset: '999',
      ...(side === 'bid' || side === 'both' ? { bidPrice: 0, bidSize: 0 } : {}),
      ...(side === 'ask' || side === 'both' ? { askPrice: 0, askSize: 0 } : {}),
    }
    const { snapshot, cut } = streamingFixtureFromRaw(
      { ...fixture.archive, quotes: [...fixture.archive.quotes, withdrawn] },
      query,
    )
    expect(cut.projection.rejections.size).toBe(0)
    expect(exclusion(snapshot)).toMatchObject({ symbol: 'AAPL', reason: 'not-ready' })
    expect(snapshot.latestQuotes['AAPL']?.sourceOffset).toBe('999')
    expect(snapshot.manifest.candidateExclusions?.some(({ symbol }) => symbol === 'AMZN')).toBe(false)
    expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
    expect(Result.isSuccess(jevRequestForSnapshot(snapshot, 'AMZN'))).toBe(true)
    expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
    for (const purpose of [IntradaySnapshotPurpose.EntryPricing, IntradaySnapshotPurpose.Liquidation])
      expect(Result.isFailure(latestQuotes({ ...query, symbols: ['AAPL'], purpose }, [withdrawn], []))).toBe(true)
    const returned = { ...previous, sourceOffset: '1000', eventAt: query.observedAt, ingestedAt: query.observedAt }
    const restored = streamingFixtureFromRaw(
      { ...fixture.archive, quotes: [...fixture.archive.quotes, withdrawn, returned] },
      query,
    ).snapshot
    expect(exclusion(restored)).toBeUndefined()
    expect(Result.isSuccess(jevRequestForSnapshot(restored, 'AAPL'))).toBe(true)
  },
)

test('a withdrawn benchmark quote remains a global prerequisite failure', () => {
  expect(() =>
    streamingFixtureFromRaw(
      {
        ...fixture.archive,
        quotes: fixture.archive.quotes.map((quote) =>
          quote.symbol === 'SPY' ? { ...quote, askPrice: 0, askSize: 0 } : quote,
        ),
      },
      query,
    ),
  ).toThrow('withdrawn bid or ask side')
})
