import { universe } from '../../src/strategy/macro-etf-core/policy'
import { etfs, mix } from '../etf-canary-macro-protocol'
import { executionRule, features, targets } from '../etf-canary-macro-signals'
import type { DailyFrame } from './macro-etf-core-dual-horizon-data'

export const o1Band = mix.band

// Use the registered Wave 5D base from main; only translate its roster and review schedule.
export const wave5dTargets = (daily: readonly DailyFrame[]) => {
  const canary = daily.map(({ date, bars }) => ({
    date,
    open: Float64Array.from(etfs, (symbol) => bars.get(symbol)?.open ?? NaN),
    close: Float64Array.from(etfs, (symbol) => bars.get(symbol)?.close ?? NaN),
  }))
  const indices = new Map<string, number>(etfs.map((symbol, i) => [symbol, i]))
  return targets(mix, features(canary), -1).map((weights, i) =>
    executionRule(mix, i).review ? universe.map((symbol) => weights[indices.get(symbol) ?? -1] ?? 0) : undefined,
  )
}
