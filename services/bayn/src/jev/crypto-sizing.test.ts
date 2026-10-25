import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from './batch'
import { decideJevEntry } from './decision'
import { jevObservationForSnapshot, nativeJevBatchResult } from './native.test-support'
import { compileJevEntry } from './runtime'
import { makeJevTradingSignalBatch } from './trading-signals'

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const) {
  test(`${symbol} compiles the model-selected complete plan with a funded quantity ceiling`, () => {
    const { snapshot } = cryptoMarketFixture(symbol, { quoteAskSize: 0.8, observedPriceChoices: true })
    const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
    const batchPlan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation,
        expiresAt: new Date(
          Date.parse(observation.observedAt) + observation.protocol.inferenceValidityMs,
        ).toISOString(),
        planVersion: JevBatchPlanVersion.V6,
      }),
    )
    const decidedAt = new Date(Date.parse(observation.observedAt) + 100).toISOString()
    const decision = Result.getOrThrow(
      decideJevEntry({
        observation,
        batchPlan,
        batchResult: nativeJevBatchResult(batchPlan, decidedAt, () => 'enter', 0.42),
        decidedAt,
      }),
    )
    expect(decision.selectedSymbols).toEqual([symbol])
    expect(batchPlan.candidates).toMatchObject([{ symbol, status: JevCandidatePlanStatus.Requested }])
    const compiled = Result.getOrThrow(compileJevEntry(decision, snapshot, snapshot))
    expect(BigInt(compiled.maximumBuyQuantityAtoms[symbol] ?? '0')).toBeGreaterThan(0n)
  })
}

test('SOL within the spread limit still requires a model-selected exit plan', () => {
  const { snapshot } = cryptoMarketFixture('SOL/USD', { quoteSpreadBps: 15 })
  const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
  const plan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation,
      expiresAt: new Date(Date.parse(observation.observedAt) + observation.protocol.inferenceValidityMs).toISOString(),
      planVersion: JevBatchPlanVersion.V6,
    }),
  )
  expect(plan.candidates.find((candidate) => candidate.symbol === 'SOL/USD')?.status).toBe(
    JevCandidatePlanStatus.Requested,
  )
})
