import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeJevTradingSignalRequest, jevStalePricingSymbols } from '../../jev/trading-signals'
import { streamingFixture, streamingFixtureFromRaw } from '../../testing/streaming-market-fixture'
import { persistIntradayRecordRows } from '../intraday/verification'
import { constructStreamingSnapshot } from './snapshot'
import { reproduceStreamingSnapshot } from './replay'

const fixture = streamingFixture()
const query = {
  ...fixture.query,
  candidateEvidencePolicy: 'bayn.candidate-evidence.quote-window-trade.v1' as const,
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

  test('reports the actual missing minute instead of blaming its necessarily absent rolling feature', () => {
    const missingAt = '2026-09-04T14:10:00.000Z'
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
    expect(exclusion(snapshot)?.reason).toBe('freshness')
    expect(snapshot.manifest.streaming.features.some((receipt) => receipt.value.material.symbol === 'AAPL')).toBe(false)
    expect(replay(snapshot).manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
  })
})
