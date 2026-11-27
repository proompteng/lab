import { expect, test } from 'bun:test'

import {
  admitPortfolioBasket,
  crossSectionalDispersion,
  dispersionMultiplier,
  sleeveRiskMultipliers,
  trailingSleeveRisk,
  updateIntradayRisk,
  volatilityMultiplier,
} from './portfolio-allocator'

const samples = Array.from({ length: 14 }, (_, i) => ({
  session: String(i).padStart(2, '0'),
  returns: [i % 2, (i % 2) * 2],
}))

test('risk uses exactly fourteen unique prior sessions, never current or future data', () => {
  const risk = trailingSleeveRisk(samples, '14', 2)
  expect(trailingSleeveRisk([...samples, { session: '14', returns: [1e9, 1e9] }], '14', 2)).toEqual(risk)
  expect(trailingSleeveRisk(samples, '13', 2).volatility).toEqual([null, null])
  expect(trailingSleeveRisk([...samples, samples[13]!], '14', 2).volatility).toEqual([null, null])
  expect(risk.volatility[1]).toBeCloseTo(2 * (risk.volatility[0] ?? 0))
  expect(risk.covariance[0]?.[1]).toBeCloseTo(risk.covariance[0]?.[0] ?? 0)
  expect(
    trailingSleeveRisk([...samples.slice(0, -1), { session: '13', returns: [null, 2] }], '14', 2).volatility[0],
  ).toBeNull()
})

test('volatility target and dispersion expand, contract, and respect the bounds', () => {
  expect([volatilityMultiplier(2, 0), volatilityMultiplier(2, 3), volatilityMultiplier(2, 8)]).toEqual([
    1.5,
    2 / 3,
    0.5,
  ])
  expect(volatilityMultiplier(2, null)).toBe(1)
  expect(dispersionMultiplier(0, 5)).toBe(0.5)
  expect(dispersionMultiplier(100, 5)).toBe(1.5)
  expect(dispersionMultiplier(6, 5)).toBeCloseTo(1.2)
  expect(dispersionMultiplier(6, 0)).toBe(1)
  expect(crossSectionalDispersion([91, 91, 89, 89])).toBe(1)
  expect(crossSectionalDispersion([1, 2, 3])).toBeNull()
})

test('ERC equalizes covariance risk contributions while preserving total capital; inverse-vol ignores correlations', () => {
  const covariance = [
    [1, 1, 0],
    [1, 4, 1],
    [0, 1, 9],
  ]
  const base = [0.35, 0.72, 0.5]
  const weight = (mode: 'erc' | 'inverse-vol') =>
    sleeveRiskMultipliers(base, covariance, mode).map((m, i) => m * (base[i] ?? 0))
  const erc = weight('erc')
  const contribution = covariance.map((row, i) => (erc[i] ?? 0) * row.reduce((sum, v, j) => sum + v * (erc[j] ?? 0), 0))
  expect(contribution[0]).toBeCloseTo(contribution[1] ?? 0, 10)
  expect(contribution[0]).toBeCloseTo(contribution[2] ?? 0, 10)
  expect(erc.reduce((sum, v) => sum + v, 0)).toBeCloseTo(1.57)
  expect(weight('inverse-vol')[0]).toBeCloseTo(2 * (weight('inverse-vol')[1] ?? 0))
  expect(sleeveRiskMultipliers(base, [[0]], 'erc')).toEqual([1, 1, 1])
  expect(sleeveRiskMultipliers([0.35, 0, 0.5], covariance, 'erc')[1]).toBe(1)
})

test('drawdown and profit lock are causal and latch independently', () => {
  const rule = { lossDrawdown: 0.015, profitTrigger: 0.015, profitGiveback: 0.005 }
  const initial = { peakReturn: 0, lossThrottled: false, profitLocked: false }
  const earlier = updateIntradayRisk(initial, 0.02, rule)
  expect(earlier).toEqual({ peakReturn: 0.02, lossThrottled: false, profitLocked: false })
  const locked = updateIntradayRisk(earlier, 0.01, rule)
  expect(locked.profitLocked).toBe(true)
  expect(locked.lossThrottled).toBe(false)
  const throttled = updateIntradayRisk(locked, 0.004, rule)
  expect(updateIntradayRisk(throttled, 0.03, rule)).toEqual({
    peakReturn: 0.03,
    lossThrottled: true,
    profitLocked: true,
  })
})

test('admission reserves gross, buying power, each leg, and the worst possible unilateral fill', () => {
  const limits = {
    grossCap: 180_000,
    grossUsed: 150_000,
    equity: 100_000,
    buyingPowerMultiple: 4,
    netCap: 100_000,
    netUsed: 90_000,
    maxLeg: 40_000,
    workingLong: 0,
    workingShort: 0,
  }
  const pair = [
    { direction: 1, dollars: 20_000 },
    { direction: -1, dollars: 20_000 },
  ] as const
  expect(admitPortfolioBasket(pair, limits)).toBe(0.5)
  expect(admitPortfolioBasket(pair, { ...limits, netUsed: 0 })).toBe(0.75)
  expect(admitPortfolioBasket(pair, { ...limits, netUsed: 0, equity: 40_000 })).toBe(0.25)
  expect(admitPortfolioBasket(pair, { ...limits, workingLong: 5_000, workingShort: 5_000 })).toBe(0.25)
  expect(admitPortfolioBasket(pair, { ...limits, maxLeg: 5_000 })).toBe(0.25)
  expect(admitPortfolioBasket(pair, { ...limits, grossUsed: 181_000 })).toBe(0)
  expect(admitPortfolioBasket(pair, { ...limits, equity: NaN })).toBe(0)
})
