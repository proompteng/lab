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
      planVersion: JevBatchPlanVersion.V8,
    }),
  )
}

test.each(['BTC/USD', 'ETH/USD', 'SOL/USD'] as const)(
  '%s uses its own verified bars and fresh quote independently of another coin',
  (symbol) => {
    const fixture = cryptoMarketFixture(symbol, { missingTradeSymbols: [symbol] })
    const features = new Map(fixture.cut.projection.features)
    for (const other of ['BTC/USD', 'ETH/USD', 'SOL/USD']) if (other !== symbol) features.delete(other)
    const snapshot = Result.getOrThrow(
      constructStreamingSnapshot(
        {
          ...fixture.cut,
          projection: { ...fixture.cut.projection, features },
        },
        fixture.query,
      ),
    )
    const plan = batch(snapshot)
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]?.status).toBe(JevCandidatePlanStatus.Requested)
    const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
    const state = Result.getOrThrow(makeJevTradingSignalRequest(observation, symbol)).input.numericalState
    expect(state).toHaveProperty('candidate.latestTrade', null)
    expect(state).not.toHaveProperty('benchmark')
    expect(state).not.toHaveProperty('relativeSignals')
    expect(snapshot.manifest.symbols).toEqual([symbol])
    expect(
      Result.getOrThrow(
        reproduceStreamingSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
      ),
    ).toEqual(snapshot)
    expect(() => cryptoMarketFixture(symbol, { quoteLagMs: 20_000 })).toThrow()
    features.delete(symbol)
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

test('unused coin quote age and trade availability cannot change the candidate request', () => {
  const before = batch(cryptoMarketFixture('BTC/USD').snapshot).candidates[0]
  const after = batch(
    cryptoMarketFixture('BTC/USD', {
      benchmarkQuoteLagMs: 600_000,
      missingTradeSymbols: ['ETH/USD'],
    }).snapshot,
  ).candidates[0]
  if (before?.status !== JevCandidatePlanStatus.Requested || after?.status !== JevCandidatePlanStatus.Requested)
    throw new Error('Expected candidate requests')
  expect(after.request.request).toEqual(before.request.request)
})
