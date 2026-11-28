import { expect, test } from 'bun:test'

import { crossAssetCanaries, crossAssetWeights } from './cross-asset-signals'
import type { CrossAssetEtf } from './policy'

const trendOf =
  (values: Partial<Record<`${CrossAssetEtf}/${CrossAssetEtf}/${number}`, number>>) =>
  (a: CrossAssetEtf, b: CrossAssetEtf, h: number) =>
    values[`${a}/${b}/${h}`] ?? 0.01

test('credit deterioration gates equity and credit even when the equity signals are positive', () => {
  const trend = trendOf({ 'HYG/IEF/21': -0.025 })
  const canaries = crossAssetCanaries(trend)
  expect(canaries).toEqual({ riskOff: true, rateShock: false })
  const weights = crossAssetWeights(trend, canaries)
  for (const symbol of ['SPY', 'QQQ', 'IWM', 'HYG'] as const) expect(weights.get(symbol)).toBe(0)
  expect(weights.get('GLD')).toBeGreaterThan(0.25)
  expect(weights.get('TLT')).toBeGreaterThan(0)
})

test('a flight to gold and simultaneous rate shock do not rotate into falling Treasuries', () => {
  const trend = trendOf({ 'GLD/SPY/21': 0.06, 'SPY/SHY/21': -0.05, 'TLT/SHY/21': -0.05, 'TLT/IEF/21': -0.03 })
  const canaries = crossAssetCanaries(trend)
  expect(canaries).toEqual({ riskOff: true, rateShock: true })
  const weights = crossAssetWeights(trend, canaries)
  expect(weights.get('TLT')).toBe(0)
  expect(weights.get('IEF')).toBe(0)
  expect(weights.get('SPY')).toBe(0)
  expect(weights.get('UUP')).toBeCloseTo(0.25, 12)
  expect(weights.get('DBC')).toBeCloseTo(0.375, 12)
})

test('medium and slow trends can veto a short rebound; total equity is a separate small budget', () => {
  const trend = trendOf({ 'DBC/SHY/21': 0.01, 'DBC/SHY/63': -0.15, 'DBC/SHY/126': -0.2 })
  const weights = crossAssetWeights(trend, crossAssetCanaries(trend))
  expect(weights.get('DBC')).toBe(0)
  expect(weights.get('GLD')).toBeCloseTo(0.35, 12)
  expect((['SPY', 'QQQ', 'IWM'] as const).map((s) => weights.get(s) ?? 0).reduce((a, b) => a + b)).toBeCloseTo(0.15, 12)
})
