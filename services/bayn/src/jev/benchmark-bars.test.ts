import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { reproduceStreamingSnapshot } from '../market-data/streaming/replay'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from './batch'
import { jevObservationForSnapshot } from './native.test-support'
import { makeJevTradingSignalBatch, makeJevTradingSignalRequest } from './trading-signals'

const batch = (snapshot: ReturnType<typeof cryptoMarketFixture>['snapshot']) => {
  const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
  return Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation,
      expiresAt: new Date(Date.parse(observation.observedAt) + observation.protocol.inferenceValidityMs).toISOString(),
      planVersion: JevBatchPlanVersion.V6,
    }),
  )
}

test('BTC can use verified ETH benchmark bars without authorizing an ETH trade', () => {
  const { snapshot } = cryptoMarketFixture('BTC/USD', { missingTradeSymbols: ['ETH/USD'] })
  const plan = batch(snapshot)
  expect(plan.candidates).toHaveLength(1)
  expect(plan.candidates[0]?.status).toBe(JevCandidatePlanStatus.Requested)
  const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
  const state = Result.getOrThrow(makeJevTradingSignalRequest(observation, 'BTC/USD')).request.state
  expect(state).toHaveProperty('benchmark.pricingBasis', 'COMPLETED_BAR_CLOSE')
  expect(state).not.toHaveProperty('benchmark.latestTrade')
  expect(state).not.toHaveProperty('benchmark.quote')
})

test('a missing ETH candidate trade excludes ETH while BTC retains the same benchmark bars', () => {
  const fixture = cryptoMarketFixture('BTC/USD', { missingTradeSymbols: ['ETH/USD'] })
  const symbols = ['BTC/USD', 'ETH/USD', 'SOL/USD']
  const snapshot = Result.getOrThrow(
    constructStreamingSnapshot(fixture.cut, {
      ...fixture.query,
      symbols,
      candidateSymbols: symbols,
      benchmarkSymbols: ['BTC/USD', 'ETH/USD'],
    }),
  )
  const plan = batch(snapshot)
  expect(plan.candidates.find((candidate) => candidate.symbol === 'BTC/USD')?.status).toBe(
    JevCandidatePlanStatus.Requested,
  )
  expect(plan.candidates.find((candidate) => candidate.symbol === 'ETH/USD')).toMatchObject({
    status: 'EXCLUDED',
    reason: 'not-ready',
    message: expect.stringContaining('lacks a trade'),
  })
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows))).toEqual(snapshot)
})

test.each(['BTC/USD', 'ETH/USD', 'SOL/USD'] as const)(
  '%s still requires its own real trade and fresh quote',
  (symbol) => {
    expect(() => cryptoMarketFixture(symbol, { missingTradeSymbols: [symbol] })).toThrow()
    expect(() => cryptoMarketFixture(symbol, { quoteLagMs: 20_000 })).toThrow()
  },
)

test.each(['BTC/USD', 'ETH/USD', 'SOL/USD'] as const)(
  '%s cannot replace missing benchmark features with candidate prices',
  (symbol) => {
    const fixture = cryptoMarketFixture(symbol)
    const benchmark = symbol === 'BTC/USD' ? 'ETH/USD' : 'BTC/USD'
    const features = new Map(fixture.cut.projection.features)
    features.delete(benchmark)
    expect(
      Result.isFailure(
        constructStreamingSnapshot(
          {
            ...fixture.cut,
            projection: { ...fixture.cut.projection, features },
          },
          fixture.query,
        ),
      ),
    ).toBe(true)
  },
)

test('unused benchmark quote age does not change verified BTC relative momentum', () => {
  const baseline = batch(cryptoMarketFixture('BTC/USD').snapshot)
  const staleBenchmark = batch(cryptoMarketFixture('BTC/USD', { benchmarkQuoteLagMs: 600_000 }).snapshot)
  const before = baseline.candidates[0]
  const after = staleBenchmark.candidates[0]
  if (before?.status !== JevCandidatePlanStatus.Requested || after?.status !== JevCandidatePlanStatus.Requested)
    throw new Error('Expected candidate requests')
  expect(after.request.request).toEqual(before.request.request)
  expect(staleBenchmark.candidates[0]).toMatchObject({ status: 'REQUESTED' })
})

test('BTC cannot use an ETH feature after its latest completed bar is missing', () => {
  const fixture = cryptoMarketFixture('BTC/USD')
  const bars = new Map(fixture.cut.projection.bars)
  bars.set(
    'ETH/USD',
    (bars.get('ETH/USD') ?? []).filter(
      (entry) => Date.parse(entry.value.eventAt) !== Date.parse(fixture.query.rangeEndAt) - 60_000,
    ),
  )
  expect(
    Result.isFailure(
      constructStreamingSnapshot(
        {
          ...fixture.cut,
          projection: { ...fixture.cut.projection, bars },
        },
        fixture.query,
      ),
    ),
  ).toBe(true)
})

test('current Jev refuses an old crypto benchmark evidence contract', () => {
  const fixture = cryptoMarketFixture('BTC/USD')
  const { benchmarkEvidencePolicy: _retired, benchmarkSymbols: _symbols, ...query } = fixture.query
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(fixture.cut, query))
  expect(Result.isFailure(jevObservationForSnapshot(snapshot))).toBe(true)
})

test.each(['BTC/USD', 'ETH/USD'])(
  'a required %s benchmark failure is unavailable source data for the complete combined query',
  (benchmark) => {
    const fixture = cryptoMarketFixture('BTC/USD')
    const features = new Map(fixture.cut.projection.features)
    features.delete(benchmark)
    const symbols = ['BTC/USD', 'ETH/USD', 'SOL/USD']
    const snapshot = constructStreamingSnapshot(
      {
        ...fixture.cut,
        projection: { ...fixture.cut.projection, features },
      },
      { ...fixture.query, symbols, candidateSymbols: symbols, benchmarkSymbols: ['BTC/USD', 'ETH/USD'] },
    )
    expect(snapshot).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'not-ready', message: expect.stringContaining('Required completed-bar benchmark') },
    })
  },
)
