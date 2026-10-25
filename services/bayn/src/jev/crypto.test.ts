import { maximumAllocatedBuyQuantities } from './entry-sizing'
import { jevCycleCandidates } from './markets'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { jevObservationForSnapshot, nativeJevBatchResult } from './native.test-support'
import { makeJevTradingSignalBatch, makeJevTradingSignalRequest } from './trading-signals'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from './batch'
import { decideJevEntry } from './decision'
import { adverseQuotePrices } from '../observe-composition/intraday-market-data'

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const) {
  test(`${symbol} retains native Sunday signals and a model-selected complete entry plan`, () => {
    const { snapshot } = cryptoMarketFixture(symbol, { observedPriceChoices: true })
    const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
    const { protocol, observedAt } = observation
    const plan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation,
        expiresAt: new Date(Date.parse(observedAt) + protocol.inferenceValidityMs).toISOString(),
        planVersion: JevBatchPlanVersion.V6,
      }),
    )
    expect(plan.candidates).toMatchObject([{ symbol, status: JevCandidatePlanStatus.Requested }])
    const signals = JSON.parse(Result.getOrThrow(makeJevTradingSignalRequest(observation, symbol)).body).state
    expect(signals.benchmark.symbol).toBe(symbol === 'BTC/USD' ? 'ETH/USD' : 'BTC/USD')
    expect(signals.session.schedule).toBe('CONTINUOUS')
    expect(signals.session.minutesUntilClose).toBeNull()
    expect(signals.candidate.technicalAvailability).toBe('RECORDED')
    expect(Object.keys(signals.candidate.technicalIndicators)).toHaveLength(14)
    const decidedAt = new Date(Date.parse(observedAt) + 100).toISOString()
    const decision = Result.getOrThrow(
      decideJevEntry({ observation, batchPlan: plan, batchResult: nativeJevBatchResult(plan, decidedAt), decidedAt }),
    )
    expect(decision.selectedSymbols).toEqual([symbol])
    expect(
      Result.getOrThrow(
        maximumAllocatedBuyQuantities({
          askPriceMicros: Result.getOrThrow(adverseQuotePrices(snapshot, [symbol])).askPriceMicros,
          targetWeights: { [symbol]: 0.2 },
          capitalMicros: observation.portfolio.brokerState.account.equityMicros,
          precision: protocol.executionModel.precision,
        }),
      )[symbol],
    ).toBe(
      (
        ((BigInt(observation.portfolio.brokerState.account.equityMicros) / 5n) * 1_000_000_000n) /
        103123457n
      ).toString(),
    )
    expect(Result.getOrThrow(adverseQuotePrices(snapshot, [symbol]))).toEqual({
      bidPriceMicros: { [symbol]: '103123456' },
      askPriceMicros: { [symbol]: '103123457' },
    })
  })
}

for (const missing of [null, 'SOL/USD', 'BTC/USD'] as const) {
  test(`one crypto observation retains every candidate with ${missing ?? 'no'} missing feature`, () => {
    const fixture = cryptoMarketFixture('ETH/USD')
    const symbols = ['BTC/USD', 'ETH/USD', 'SOL/USD']
    const features = new Map(fixture.cut.projection.features)
    if (missing !== null) features.delete(missing)
    const snapshotResult = constructStreamingSnapshot(
      { ...fixture.cut, projection: { ...fixture.cut.projection, features } },
      { ...fixture.query, symbols, candidateSymbols: symbols, benchmarkSymbols: ['BTC/USD', 'ETH/USD'] },
    )
    if (missing === 'BTC/USD') {
      expect(snapshotResult).toMatchObject({ _tag: 'Failure', failure: { reason: 'not-ready' } })
      return
    }
    const snapshot = Result.getOrThrow(snapshotResult)
    const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
    const { protocol } = observation
    const plan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation,
        expiresAt: new Date(Date.parse(observation.observedAt) + protocol.inferenceValidityMs).toISOString(),
        planVersion: JevBatchPlanVersion.V6,
      }),
    )
    expect(plan.candidates.map((candidate) => candidate.symbol)).toEqual(symbols)
    expect(
      jevCycleCandidates(
        { window: { executionCalendarSchemaVersion: 'bayn.continuous-market-hours.v1' } },
        protocol.candidateSymbols,
      ),
    ).toEqual(symbols)
    if (missing === 'SOL/USD') {
      expect(plan.candidates.find((candidate) => candidate.symbol === 'SOL/USD')).toMatchObject({
        status: 'EXCLUDED',
        reason: 'not-ready',
      })
      expect(plan.candidates.find((candidate) => candidate.symbol === 'ETH/USD')).toMatchObject({
        status: 'REQUESTED',
      })
    }
  })
}
