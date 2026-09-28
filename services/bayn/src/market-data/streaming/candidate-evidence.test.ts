import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeJevTradingSignalRequest, jevStalePricingSymbols } from '../../jev/trading-signals'
import { streamingFixture, streamingFixtureFromRaw } from '../../testing/streaming-market-fixture'
import { IntradayCandidateEvidencePolicy, IntradaySnapshotPurpose } from '../intraday/model'
import { persistIntradayRecordRows, verifyIntradaySnapshotQuery } from '../intraday/verification'
import { constructSimulatedSnapshot, constructStreamingSnapshot } from './snapshot'
import { reproduceSimulatedSnapshot, reproduceStreamingSnapshot } from './replay'
import { simulationFixture } from '../../testing/simulated-streaming-fixture'

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
const exclusion = (snapshot: typeof fixture.snapshot) =>
  snapshot.manifest.candidateExclusions?.find((entry) => entry.symbol === 'AAPL')
const replay = (snapshot: typeof fixture.snapshot) =>
  Result.getOrThrow(
    reproduceStreamingSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
  )

describe('candidate executable quote and window trade evidence', () => {
  test('uses a current quote with an older real window trade and exposes its actual age to Jev', () => {
    const { snapshot } = streamingFixtureFromRaw(
      withTimes('AAPL', '2026-09-04T14:30:01.000Z', '2026-09-04T14:20:00.000Z'),
      query,
    )
    expect(exclusion(snapshot)).toBeUndefined()
    expect(jevStalePricingSymbols(snapshot)).not.toContain('AAPL')
    const state = JSON.parse(Result.getOrThrow(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY')).body).state
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
    expect(Result.isSuccess(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
    expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
  })

  test('retains verified features for rejected candidates without admitting their stale quotes', () => {
    const { snapshot } = streamingFixtureFromRaw(
      withTimes('AAPL', '2026-09-04T14:29:51.999Z', '2026-09-04T14:20:00.000Z'),
      query,
    )
    expect(exclusion(snapshot)?.reason).toBe('freshness')
    expect(snapshot.manifest.streaming.features.some((receipt) => receipt.value.material.symbol === 'AAPL')).toBe(true)
    expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
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
      expect(exclusion(snapshot)?.message).toBe(`rolling window lacks 1 of 30 required minute bars: ${missingAt}`)
      expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
      expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
    },
  )

  test('preserves delayed-bar rejection when the range-completion bar is also missing', () => {
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
    expect(exclusion(snapshot)?.reason).toBe('freshness')
    expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
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
    expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
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
      expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
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
    expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
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
      expect(Result.isSuccess(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(allowed)
    }
  })

  test('rejects future-dated signal prices within the producer clock allowance', () => {
    for (const [quoteAt, tradeAt] of [
      ['2026-09-04T14:30:02.001Z', '2026-09-04T14:20:00.000Z'],
      ['2026-09-04T14:30:01.000Z', '2026-09-04T14:30:02.001Z'],
    ] as const) {
      const { snapshot } = streamingFixtureFromRaw(withTimes('AAPL', quoteAt, tradeAt), query)
      expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
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
    expect(Result.isFailure(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
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
    expect(Result.isSuccess(makeJevTradingSignalRequest(snapshot, 'AAPL', 'SPY'))).toBe(true)
  })
})
