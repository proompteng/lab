import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { jevEntryEconomics } from './entry-economics'
import { defaultJevProtocolDocument } from './protocol'
import { JevFundedExitPlanSchema } from './strategy-exit-plan'
import { jevTradePlanQuestion } from './trade-plan-choices'

const plansForRange = (
  rangeUsd: number,
  capitalMicros = '100000000000',
  priceUsd = 100,
  symbol: 'BTC/USD' | 'ETH/USD' | 'SOL/USD' = 'ETH/USD',
) => {
  const { snapshot } = cryptoMarketFixture(symbol)
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      protocol: defaultJevProtocolDocument,
      symbol,
      bidMicros: BigInt(Math.round(priceUsd * 1_000_000)),
      askMicros: BigInt(Math.round((priceUsd + 0.01) * 1_000_000)),
      capitalMicros,
    }),
  )
  if (economics === null) throw new Error('Expected funded crypto economics')
  const quote = snapshot.latestQuotes[symbol]
  if (quote === undefined) throw new Error('Expected crypto quote')
  const question = Result.getOrThrow(
    jevTradePlanQuestion({
      protocol: defaultJevProtocolDocument,
      symbol,
      economics,
      snapshot: {
        ...snapshot,
        latestQuotes: {
          ...snapshot.latestQuotes,
          [symbol]: { ...quote, bidPrice: priceUsd, askPrice: priceUsd + 0.01 },
        },
        bars: snapshot.bars.map((bar) =>
          bar.symbol === symbol
            ? { ...bar, open: priceUsd, high: priceUsd, low: priceUsd - rangeUsd, close: priceUsd }
            : bar,
        ),
      },
    }),
  )
  const plans = Object.values(question.criteria).flatMap((criterion) => {
    if (criterion === null || typeof criterion !== 'object' || Array.isArray(criterion) || !('plan' in criterion))
      return []
    return [Schema.decodeUnknownSync(JevFundedExitPlanSchema)(criterion['plan'])]
  })
  return { question, plans, economics }
}

test.each([0, 0.1, 0.25])('a %s USD observed range retains a fee-covering hypothetical plan', (range) => {
  const { plans, question, economics } = plansForRange(range)
  expect(economics.takeProfitBreakEvenLimitUsd).toBeGreaterThan(100.5)
  expect(plans.length).toBeGreaterThan(0)
  expect(Object.keys(question.criteria)).toContain('wait')
  expect(Object.keys(question.criteria)).toContain('avoid')
  for (const plan of plans) {
    expect(BigInt(plan.estimatedTargetNetMicros)).toBeGreaterThan(BigInt(plan.acquisitionCostMicros))
    expect(BigInt(plan.estimatedStopNetMicros)).toBeLessThan(BigInt(plan.acquisitionCostMicros))
    expect(Number(plan.levels.profitLimitPriceMicros) / 1_000_000).toBeGreaterThanOrEqual(
      economics.takeProfitBreakEvenLimitUsd,
    )
    expect(plan.levels.maximumHoldingMinutes).toBe(60)
  }
})

test.each([0, 0.1, 0.25])('a quiet %s USD range offers net reward that covers its modeled loss', (range) => {
  const { plans } = plansForRange(range)
  expect(plans.length).toBeGreaterThan(0)
  expect(plans.length).toBeLessThanOrEqual(16)
  for (const plan of plans) {
    const acquisition = BigInt(plan.acquisitionCostMicros)
    const loss = acquisition - BigInt(plan.estimatedStopNetMicros)
    expect(BigInt(plan.estimatedTargetNetMicros) - acquisition).toBeGreaterThanOrEqual(loss)
  }
})

test('a sub-unit BTC allocation has strictly positive funded proceeds despite price and cash rounding', () => {
  const { plans, economics } = plansForRange(0, '90000000000', 80_000, 'BTC/USD')
  expect(Number(economics.receivedQuantityAtoms)).toBeLessThan(1_000_000_000)
  expect(plans.length).toBeGreaterThan(0)
  for (const plan of plans) {
    const acquisition = BigInt(plan.acquisitionCostMicros)
    expect(BigInt(plan.estimatedTargetNetMicros) - acquisition).toBeGreaterThanOrEqual(
      acquisition - BigInt(plan.estimatedStopNetMicros),
    )
  }
})

test('an unreachable net-reward scenario retains other fundable market-price choices', () => {
  const { plans, question, economics } = plansForRange(99.99)
  expect(plans.length).toBeGreaterThan(0)
  expect(plans.length).toBeLessThanOrEqual(16)
  const deepestStop = plans.reduce(
    (minimum, plan) => (BigInt(plan.levels.stopPriceMicros) < minimum ? BigInt(plan.levels.stopPriceMicros) : minimum),
    BigInt(economics.maximumEntryPriceMicros),
  )
  const alternatives = Object.values(question.criteria).flatMap((criterion) => {
    if (criterion === null || typeof criterion !== 'object' || Array.isArray(criterion) || !('plan' in criterion))
      return []
    const plan = Schema.decodeUnknownSync(JevFundedExitPlanSchema)(criterion['plan'])
    return BigInt(plan.levels.stopPriceMicros) === deepestStop
      ? ['targetBasis' in criterion ? criterion['targetBasis'] : undefined]
      : []
  })
  expect(alternatives.length).toBeGreaterThan(0)
  expect(alternatives.every((targetBasis) => targetBasis === 'OBSERVED_RANGE_ORDER_SCENARIO')).toBe(true)
})

test('missing allocation economics still supplies only abstention', () => {
  const { snapshot } = cryptoMarketFixture()
  const question = Result.getOrThrow(
    jevTradePlanQuestion({ snapshot, symbol: 'BTC/USD', economics: null, protocol: defaultJevProtocolDocument }),
  )
  expect(Object.keys(question.criteria).sort()).toEqual(['avoid', 'wait'])
})

test('funded targets retain their market-price anchors when position size changes', () => {
  const targetPrices = (capital: string) => {
    const { plans, question } = plansForRange(4, capital)
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      expect(BigInt(plan.estimatedTargetNetMicros)).toBeGreaterThan(BigInt(plan.acquisitionCostMicros))
      expect(BigInt(plan.estimatedStopNetMicros)).toBeLessThan(BigInt(plan.acquisitionCostMicros))
    }
    return [
      ...new Set(
        Object.values(question.criteria).flatMap((criterion) => {
          if (
            criterion === null ||
            typeof criterion !== 'object' ||
            Array.isArray(criterion) ||
            !('targetBasis' in criterion) ||
            criterion['targetBasis'] !== 'OBSERVED_RANGE_ORDER_SCENARIO' ||
            !('plan' in criterion)
          )
            return []
          return [Schema.decodeUnknownSync(JevFundedExitPlanSchema)(criterion['plan']).levels.profitLimitPriceMicros]
        }),
      ),
    ]
  }
  expect(targetPrices('100000000000')).toEqual(['101000000', '102000000', '108000000'])
  expect(targetPrices('1000000000000')).toEqual(targetPrices('100000000000'))
})
