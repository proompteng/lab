// The caller observes a completed checkpoint. Samples on or after its session are never admissible.
export interface SleeveReturn {
  readonly session: string
  readonly returns: readonly (number | null)[]
}

const lookback = 14
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const bounded = (value: number) => Math.max(0.5, Math.min(1.5, value))
const positive = (value: number) => Number.isFinite(value) && value > 0

export const crossSectionalDispersion = (values: readonly number[]): number | null => {
  if (values.length < 4 || !values.every(Number.isFinite)) return null
  const center = mean(values)
  return Math.sqrt(mean(values.map((value) => (value - center) ** 2)))
}

export const volatilityMultiplier = (target: number | null, realized: number | null) =>
  target === null || realized === null || !positive(target) || !Number.isFinite(realized) || realized < 0
    ? 1
    : bounded(target / realized)

export const dispersionMultiplier = (current: number | null, trailingMedian: number | null, elasticity = 1) =>
  current === null ||
  trailingMedian === null ||
  !positive(trailingMedian) ||
  !Number.isFinite(current) ||
  current < 0 ||
  !positive(elasticity)
    ? 1
    : bounded((current / trailingMedian) ** elasticity)

export const trailingSleeveRisk = (history: readonly SleeveReturn[], session: string, sleeveCount: number) => {
  const prior = history.filter((row) => row.session < session).toSorted((a, b) => a.session.localeCompare(b.session))
  const window = prior.slice(-lookback)
  const complete = window.length === lookback && new Set(window.map((row) => row.session)).size === lookback
  const lanes = Array.from({ length: sleeveCount }, (_, column) => {
    const values = window.map((row) => row.returns[column])
    if (!complete || !values.every((value): value is number => typeof value === 'number' && Number.isFinite(value)))
      return null
    const center = mean(values)
    return values.map((value) => value - center)
  })
  const covariance = lanes.map((left, i) =>
    lanes.map((right, j) =>
      left === null || right === null
        ? null
        : (left.reduce((sum, value, k) => sum + value * (right[k] ?? 0), 0) / (lookback - 1)) * (i === j ? 1 : 0.5),
    ),
  )
  return {
    covariance,
    volatility: covariance.map((row, i) => {
      const variance = row[i]
      return variance == null ? null : Math.sqrt(variance)
    }),
  }
}

// Positive coordinate descent for xᵢ(Σx)ᵢ = 1, then normalize x to a capital budget.
// Missing/degenerate covariance leaves the original capital budget unchanged.
export const sleeveRiskMultipliers = (
  baseBudget: readonly number[],
  covariance: readonly (readonly (number | null)[])[],
  mode: 'inverse-vol' | 'erc',
): readonly number[] => {
  const neutral = baseBudget.map(() => 1)
  const active = baseBudget.flatMap((weight, i) => (positive(weight) ? [i] : []))
  if (active.length < 2) return neutral
  const matrix = active.map((i) => active.map((j) => covariance[i]?.[j] ?? NaN))
  const deviations = matrix.map((row, i) => Math.sqrt(row[i] ?? NaN))
  if (!deviations.every(positive) || !matrix.every((row) => row.every(Number.isFinite))) return neutral
  // Iterate in correlation space to remove differences in sleeve units.
  const corr = matrix.map((row, i) => row.map((value, j) => value / ((deviations[i] ?? 1) * (deviations[j] ?? 1))))
  const x = active.map(() => 1)
  if (mode === 'erc') {
    for (let step = 0; step < 64; step++) {
      for (const [i, row] of corr.entries()) {
        const cross = row.reduce((sum, value, j) => (i === j ? sum : sum + value * (x[j] ?? 0)), 0)
        x[i] = (Math.hypot(cross, 2) - cross) / 2
      }
    }
    if (
      !corr.every(
        (row, i) => Math.abs((x[i] ?? 0) * row.reduce((sum, value, j) => sum + value * (x[j] ?? 0), 0) - 1) < 1e-7,
      )
    )
      return neutral
  }
  const weights = x.map((value, i) => value / (deviations[i] ?? 1))
  const mass = weights.reduce((sum, weight) => sum + weight, 0)
  const total = baseBudget.reduce((sum, weight) => sum + weight, 0)
  const multipliers = [...neutral]
  for (const [i, sleeve] of active.entries()) {
    multipliers[sleeve] = ((weights[i] ?? 0) / mass) * (total / (baseBudget[sleeve] ?? 1))
  }
  return multipliers.every(positive) ? multipliers : neutral
}

export interface PortfolioThrottle {
  readonly lossDrawdown?: number
  readonly profitTrigger?: number
  readonly profitGiveback?: number
}

export interface IntradayRiskState {
  readonly peakReturn: number
  readonly lossThrottled: boolean
  readonly profitLocked: boolean
}

export const updateIntradayRisk = (
  prior: IntradayRiskState,
  markedReturn: number,
  rule: PortfolioThrottle,
): IntradayRiskState => {
  if (!Number.isFinite(markedReturn)) return prior
  const peakReturn = Math.max(prior.peakReturn, markedReturn)
  const drawdown = peakReturn - markedReturn
  return {
    peakReturn,
    lossThrottled: prior.lossThrottled || (rule.lossDrawdown !== undefined && drawdown >= rule.lossDrawdown),
    profitLocked:
      prior.profitLocked ||
      (rule.profitTrigger !== undefined &&
        rule.profitGiveback !== undefined &&
        peakReturn >= rule.profitTrigger &&
        drawdown >= rule.profitGiveback),
  }
}

export interface GrossRequest {
  readonly direction: 1 | -1
  readonly dollars: number
}

// Include open positions at a current mark and every working order at its worst funded notional.
// Cap the same fraction of every leg; even one-sided fills must respect directional net headroom.
export const admitPortfolioBasket = (
  requested: readonly GrossRequest[],
  limits: {
    readonly grossCap: number
    readonly grossUsed: number
    readonly equity: number
    readonly buyingPowerMultiple: number
    readonly netCap: number
    readonly maxLeg: number
    readonly netUsed: number
    readonly workingLong: number
    readonly workingShort: number
  },
): number => {
  const { grossCap, grossUsed, equity, buyingPowerMultiple, netCap, maxLeg, netUsed, workingLong, workingShort } =
    limits
  if (
    ![grossCap, grossUsed, equity, buyingPowerMultiple, netCap, maxLeg, netUsed, workingLong, workingShort].every(
      Number.isFinite,
    ) ||
    grossUsed < Math.abs(netUsed) - 1e-8 ||
    workingLong < 0 ||
    workingShort < 0 ||
    ![grossCap, equity, buyingPowerMultiple, netCap, maxLeg].every(positive) ||
    requested.length === 0 ||
    requested.some(({ dollars, direction }) => !positive(dollars) || (direction !== 1 && direction !== -1))
  )
    return 0
  const long = requested.reduce((sum, leg) => sum + (leg.direction === 1 ? leg.dollars : 0), 0)
  const short = requested.reduce((sum, leg) => sum + (leg.direction === -1 ? leg.dollars : 0), 0)
  return Math.max(
    0,
    Math.min(
      1,
      (Math.min(grossCap, equity * buyingPowerMultiple) - grossUsed - workingLong - workingShort) / (long + short),
      long === 0 ? 1 : (netCap - netUsed - workingLong) / long,
      short === 0 ? 1 : (netCap + netUsed - workingShort) / short,
      ...requested.map(({ dollars }) => maxLeg / dollars),
    ),
  )
}
