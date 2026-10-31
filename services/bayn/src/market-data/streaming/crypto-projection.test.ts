import { expect, test } from 'bun:test'
import { jevRequestForSnapshot } from '../../jev/native.test-support'
import { jevStalePricingSymbols } from '../../jev/trading-signals'
import { Result } from 'effect'

import { cryptoMarketFixture, cryptoMomentumFixture } from '../../testing/crypto-market-fixture'
import { reproduceStreamingSnapshot } from './replay'
import { latestQuotes, persistIntradayRecordRows } from '../intraday/verification'
import { constructStreamingSnapshot } from './snapshot'

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const) {
  test(`${symbol} reproduces its native snapshot while the shared consumer also carries equity technical features`, () => {
    const { cut, query } = cryptoMarketFixture(symbol)
    const shared = {
      ...cut,
      projection: { ...cut.projection, technicalTopic: 'torghut.technical-features.v1' },
    }
    const snapshot = Result.getOrThrow(constructStreamingSnapshot(shared, query))
    const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
    const reproduced = Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows))
    expect(reproduced.manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
    expect(snapshot.manifest.streaming.technical).toBeUndefined()
    expect(snapshot.manifest.streaming.features).toHaveLength(1)
  })
}

test('native candidate features reproduce a Sunday snapshot crossing midnight through the shared projection', () => {
  const { snapshot, rows, fixtures, cut } = cryptoMarketFixture()
  expect([...cut.projection.rejections.values()].flat()).toEqual([])
  expect(snapshot.bars).toHaveLength(61)
  expect(snapshot.bars[0]?.volume).toBe(0.000000001)
  expect(snapshot.manifest.streaming.features.map((receipt) => receipt.value.featureId).sort()).toEqual(
    fixtures
      .filter((fixture) => snapshot.manifest.symbols.includes(fixture.feature.material.symbol))
      .map((fixture) => fixture.feature.featureId)
      .sort(),
  )
  const reproduced = Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows))
  expect(reproduced.manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
})

test('crypto requests keep executable quote signals separate from their own verified completed bars', () => {
  const { snapshot, rows } = cryptoMarketFixture()
  const state = JSON.parse(Result.getOrThrow(jevRequestForSnapshot(snapshot, 'BTC/USD')).body).numericalState
  expect(state).not.toHaveProperty('relativeSignals')
  expect(state).not.toHaveProperty('benchmark')
  expect(state.candidate).not.toHaveProperty('currentPriceSignals')
  expect(state.candidate.quote.bid).toBe(snapshot.latestQuotes['BTC/USD']?.bidPrice)
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest.snapshotId).toBe(
    snapshot.manifest.snapshotId,
  )
})

test.each(['BTC/USD', 'ETH/USD', 'SOL/USD'] as const)(
  '%s current quote signals cannot be capped by an old contextual trade',
  (symbol) => {
    const fresh = cryptoMarketFixture(symbol)
    const oldPrint = cryptoMarketFixture(symbol, { tradeLagMs: 12 * 60_000, tradePrice: 100 })
    const freshState = JSON.parse(Result.getOrThrow(jevRequestForSnapshot(fresh.snapshot, symbol)).body).numericalState
    const oldPrintState = JSON.parse(
      Result.getOrThrow(jevRequestForSnapshot(oldPrint.snapshot, symbol)).body,
    ).numericalState
    expect(oldPrintState.candidate.bars1m).toEqual(freshState.candidate.bars1m)
    expect(oldPrintState.candidate.latestTrade.ageMs).toBe(721000)
    expect(oldPrintState.candidate.latestTrade.price).toBe(100)
    expect(oldPrintState.candidate.quote).toEqual(freshState.candidate.quote)
    expect(oldPrintState.entryEconomics).toEqual(freshState.entryEconomics)
    expect(
      Result.getOrThrow(reproduceStreamingSnapshot(oldPrint.snapshot.manifest, oldPrint.rows)).manifest.snapshotId,
    ).toBe(oldPrint.snapshot.manifest.snapshotId)
  },
)

test('a wider current crypto quote changes funded entry costs without changing completed bars', () => {
  const narrow = cryptoMarketFixture('BTC/USD', { quoteSpreadBps: 1 })
  const wide = cryptoMarketFixture('BTC/USD', { quoteSpreadBps: 20 })
  const narrowState = JSON.parse(
    Result.getOrThrow(jevRequestForSnapshot(narrow.snapshot, 'BTC/USD')).body,
  ).numericalState
  const wideState = JSON.parse(Result.getOrThrow(jevRequestForSnapshot(wide.snapshot, 'BTC/USD')).body).numericalState
  expect(wideState.candidate.bars1m).toEqual(narrowState.candidate.bars1m)
  expect(wideState.candidate.quote.bid).toBe(narrowState.candidate.quote.bid)
  expect(wideState.candidate.quote.ask).toBeGreaterThan(narrowState.candidate.quote.ask)
  expect(wideState.entryEconomics.maximumEntryPriceUsd).toBeGreaterThan(narrowState.entryEconomics.maximumEntryPriceUsd)
  expect(BigInt(wideState.entryEconomics.maximumQuantityAtoms)).toBeLessThan(
    BigInt(narrowState.entryEconomics.maximumQuantityAtoms),
  )
  for (const fixture of [narrow, wide])
    expect(
      Result.getOrThrow(reproduceStreamingSnapshot(fixture.snapshot.manifest, fixture.rows)).manifest.snapshotId,
    ).toBe(fixture.snapshot.manifest.snapshotId)
})

test('crypto replay rejects a normalized price substituted beneath an unchanged native payload', () => {
  const { snapshot, rows } = cryptoMarketFixture()
  const changed = {
    ...rows,
    bars: rows.bars.map((row, index) => {
      if (typeof row !== 'object' || row === null) throw new Error('Expected a retained bar object')
      return index === 0 ? { ...row, open: 102, high: 102, low: 102, close: 102, vwap: 102 } : row
    }),
  }
  expect(Result.isFailure(reproduceStreamingSnapshot(snapshot.manifest, changed))).toBe(true)
})

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const) {
  test(`${symbol} uses completed benchmark bars while retaining fresh executable candidate quotes`, () => {
    expect(() => cryptoMomentumFixture(symbol, { benchmarkQuoteLagMs: 9001 })).not.toThrow()
    const { query, snapshot, rows } = cryptoMomentumFixture(symbol, { benchmarkQuoteLagMs: 9000, tradeLagMs: 60_000 })
    expect(jevStalePricingSymbols(snapshot)).toEqual([])
    expect(reproduceStreamingSnapshot(snapshot.manifest, rows)).toMatchObject({ _tag: 'Success' })
    const {
      candidateSymbols: _candidates,
      benchmarkEvidencePolicy: _policy,
      benchmarkSymbols: _benchmarks,
      ...requiredQuery
    } = query
    const benchmark = symbol === 'BTC/USD' ? 'ETH/USD' : 'BTC/USD'
    const staleQuotes = snapshot.quotes.map((quote) =>
      quote.symbol === benchmark
        ? { ...quote, eventAt: new Date(Date.parse(query.observedAt) - 10_001).toISOString() }
        : quote,
    )
    expect(latestQuotes(requiredQuery, staleQuotes, snapshot.trades)).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'freshness', facts: { symbol: benchmark } },
    })
  })

  test(`${symbol} requires candidate quotes with optional actual trade context and no benchmark prerequisite`, () => {
    const benchmark = symbol === 'BTC/USD' ? 'ETH/USD' : 'BTC/USD'
    expect(() => cryptoMarketFixture(symbol, { missingTradeSymbols: [benchmark] })).not.toThrow()
    const { snapshot, rows } = cryptoMarketFixture(symbol, { tradeLagMs: 60_000 })
    expect(jevStalePricingSymbols(snapshot)).toEqual([])
    const state = JSON.parse(Result.getOrThrow(jevRequestForSnapshot(snapshot, symbol)).body).numericalState
    expect(state.candidate.quote.ageMs).toBe(1000)
    expect(state.candidate.latestTrade.ageMs).toBe(61000)
    expect(state).not.toHaveProperty('benchmark')
    expect(snapshot.manifest.symbols).toEqual([symbol])
    expect(reproduceStreamingSnapshot(snapshot.manifest, rows)).toMatchObject({ _tag: 'Success' })
    const absent = cryptoMarketFixture(symbol, { tradeLagMs: 121 * 60_000 })
    expect(
      JSON.parse(Result.getOrThrow(jevRequestForSnapshot(absent.snapshot, symbol)).body).numericalState,
    ).toHaveProperty('candidate.latestTrade', null)
    expect(() => cryptoMarketFixture(symbol, { quoteLagMs: 10_001 })).toThrow()
    expect(() => cryptoMarketFixture(symbol, { tradeLagMs: -10_000 })).toThrow()
  })
}
