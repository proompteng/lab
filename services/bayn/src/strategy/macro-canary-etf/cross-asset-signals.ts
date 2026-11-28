import { type CrossAssetEtf, crossAssetEtfs, crossAssetV2 as spec } from './policy'

/** Completed-close log return of the price ratio over a single, matched horizon. */
type RelativeTrend = (symbol: CrossAssetEtf, benchmark: CrossAssetEtf, horizon: number) => number

export const crossAssetCanaries = (trend: RelativeTrend) => {
  const [fast] = spec.horizons
  return {
    riskOff:
      trend('HYG', 'IEF', fast) <= spec.creditStress ||
      (trend('GLD', 'SPY', fast) >= spec.flightToSafety && trend('SPY', 'SHY', fast) < 0),
    rateShock: trend('TLT', 'SHY', fast) <= spec.durationShock && trend('TLT', 'IEF', fast) < 0,
  }
}

export const crossAssetWeights = (
  trend: RelativeTrend,
  { riskOff, rateShock }: ReturnType<typeof crossAssetCanaries>,
) => {
  const weights = new Map<CrossAssetEtf, number>()
  const [fast, middle, slow] = spec.horizons
  const [fastWeight, middleWeight, slowWeight] = spec.horizonWeights
  const conviction = (symbol: CrossAssetEtf) =>
    Math.max(
      0,
      (fastWeight * trend(symbol, 'SHY', fast)) / Math.sqrt(fast) +
        (middleWeight * trend(symbol, 'SHY', middle)) / Math.sqrt(middle) +
        (slowWeight * trend(symbol, 'SHY', slow)) / Math.sqrt(slow),
    )
  const allocate = (symbols: readonly CrossAssetEtf[], budget: number) => {
    const scores = symbols.map((symbol) => ({ symbol, score: conviction(symbol) }))
    const total = scores.reduce((sum, { score }) => sum + score, 0)
    if (total === 0) return
    for (const { symbol, score } of scores) weights.set(symbol, (budget * score) / total)
  }
  if (!riskOff) {
    allocate(spec.equity, spec.equityBudget)
    allocate([spec.credit], spec.creditBudget)
  }
  // An equity selloff does not by itself authorize duration: rising-rate
  // episodes can hurt stocks and Treasuries together.
  if (!rateShock) allocate(spec.duration, spec.durationBudget)
  allocate(
    spec.realAssets,
    spec.realAssetBudget +
      (riskOff ? spec.equityBudget + spec.creditBudget : 0) +
      (rateShock ? spec.rateShockRealAssetTilt : 0),
  )
  allocate([spec.dollar], spec.dollarBudget + (rateShock ? spec.durationBudget - spec.rateShockRealAssetTilt : 0))
  const invested = [...weights.values()].reduce((sum, weight) => sum + weight, 0)
  weights.set(spec.carry, Math.min(spec.maxEtfWeight, Math.max(0, 1 - invested)))
  return new Map(crossAssetEtfs.map((symbol) => [symbol, weights.get(symbol) ?? 0]))
}
