import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { jevObservationForSnapshot, nativeJevFixture } from './native.test-support'
import { makeJevTradingSignalRequest } from './trading-signals'
import { jevTradePlanQuestion } from './trade-plan-choices'
import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { jevEntryEconomics } from './entry-economics'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'

test('provider bar context can exceed broker price precision without changing raw evidence', () => {
  const { snapshot } = cryptoMarketFixture('SOL/USD')
  const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      cryptoFeeTier: null,

      protocol: observation.protocol,
      symbol: 'SOL/USD',
      bidMicros: 103123456n,
      askMicros: 103123457n,
      capitalMicros: observation.portfolio.brokerState.account.equityMicros,
    }),
  )
  const bar = snapshot.bars.find((entry) => entry.symbol === 'SOL/USD')
  if (bar === undefined) throw new Error('Expected SOL history')
  const observed = {
    ...bar,
    open: 107.677,
    high: 107.77,
    low: 107.674,
    close: 107.7667664385,
    volume: 0,
    tradeCount: '0',
  }
  const input = {
    snapshot: { ...snapshot, bars: [observed] },
    symbol: 'SOL/USD',
    economics,
    protocol: observation.protocol,
  }
  const question = Result.getOrThrow(jevTradePlanQuestion(input))
  expect(question).toEqual(
    Result.getOrThrow(
      jevTradePlanQuestion({ ...input, snapshot: { ...snapshot, bars: [{ ...observed, close: 107.766766 }] } }),
    ),
  )
  expect(Object.keys(question.criteria).filter((choice) => choice.startsWith('plan_'))).toHaveLength(16)
  expect(observed.close).toBe(107.7667664385)
  expect(priceNumberToMicros(observed.close, 'broker quote')).toMatchObject({
    _tag: 'Failure',
    failure: { reason: 'precision-exceeded' },
  })
  for (const close of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    expect(jevTradePlanQuestion({ ...input, snapshot: { ...snapshot, bars: [{ ...observed, close }] } })).toMatchObject(
      {
        _tag: 'Failure',
        failure: { _tag: 'InvalidFixedPointNumber', field: 'observed plan context' },
      },
    )
  }
})

test('a fresh high still offers complete cost-valid hypothetical plans and explicit abstention', () => {
  const fixture = nativeJevFixture(undefined, undefined, undefined, undefined, undefined, undefined, undefined, false)
  const prepared = Result.getOrThrow(makeJevTradingSignalRequest(fixture.observation.payload, 'AAPL'))
  expect(Object.keys(prepared.request.questions)).toEqual(['action', 'setup'])
  const action = prepared.request.questions['action']
  if (action?.type !== 'choice') throw new Error('Expected a plan choice')
  expect(action.criteria).toHaveProperty('wait')
  expect(action.criteria).toHaveProperty('avoid')
  const plans = Object.entries(action.criteria).filter(([name]) => name.startsWith('plan_'))
  expect(plans.length).toBeGreaterThan(1)
  expect(plans.length).toBeLessThanOrEqual(16)
  const state = JSON.parse(prepared.body).state
  for (const [, value] of plans) {
    expect(value).toHaveProperty('plan')
    expect(value).toHaveProperty('priceBasis', 'HYPOTHETICAL_ORDER_PRICES')
    expect(value).toHaveProperty('plan.levels.symbol', 'AAPL')
    const serialized = JSON.parse(JSON.stringify(value))
    expect(BigInt(serialized.plan.estimatedTargetNetMicros)).toBeGreaterThan(
      BigInt(serialized.plan.acquisitionCostMicros),
    )
    expect(Number(serialized.plan.levels.profitLimitPriceMicros) / 1_000_000).toBeGreaterThan(
      state.entryEconomics.takeProfitBreakEvenLimitUsd,
    )
  }
})
