const annualization = Math.sqrt(252)

export const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
export const mean = (values: readonly number[]) => sum(values) / values.length

const sampleDeviation = (values: readonly number[]) => {
  if (values.length < 2 || values.every((value) => value === values[0])) return 0
  const center = mean(values)
  return Math.sqrt(sum(values.map((value) => (value - center) ** 2)) / (values.length - 1))
}

const scaledSharpe = (values: readonly number[], scale: number) => {
  const deviation = sampleDeviation(values)
  return Number.isFinite(deviation) && deviation > 0 ? (mean(values) * scale) / deviation : null
}

export const dailySharpe = (values: readonly number[]) => scaledSharpe(values, 1)
export const sharpe = (daily: readonly number[]) => scaledSharpe(daily, annualization)

export const sortino = (daily: readonly number[]) => {
  const downside = Math.sqrt(mean(daily.map((value) => Math.min(0, value) ** 2)))
  const average = mean(daily)
  return Number.isFinite(average) && Number.isFinite(downside) && downside > 0
    ? (average * annualization) / downside
    : null
}

export const wealth = (returns: readonly number[], compound: boolean) =>
  compound ? returns.reduce((nav, value) => nav * (1 + value), 1) : 1 + sum(returns)

export const maxDrawdown = (returns: readonly number[], compound: boolean) => {
  let nav = 1
  let peak = 1
  let drawdown = 0
  for (const value of returns) {
    nav = compound ? nav * (1 + value) : nav + value
    peak = Math.max(peak, nav)
    drawdown = Math.max(drawdown, 1 - nav / peak)
  }
  return drawdown
}

export const calmar = (annualReturn: number | null, drawdown: number) =>
  annualReturn !== null && drawdown > 0 ? annualReturn / drawdown : null

const requirePairs = (strategy: readonly number[], benchmark: readonly number[]) => {
  if (strategy.length !== benchmark.length) throw new Error('Paired return series must have the same session count')
}

/** Difference of two annualized Sharpes on matched sessions, not the Sharpe of excess returns. */
export const pairedSharpeDiff = (strategy: readonly number[], benchmark: readonly number[]) => {
  requirePairs(strategy, benchmark)
  const a = sharpe(strategy)
  const b = sharpe(benchmark)
  return a === null || b === null ? null : a - b
}

/** Trim the strategy's best positive days from both paths, breaking ties in chronological order. */
export const exTopExcess = (
  strategy: readonly number[],
  benchmark: readonly number[],
  compound: boolean,
  counts: readonly number[],
) => {
  requirePairs(strategy, benchmark)
  const ranked = strategy
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index)
  return counts.map((count) => {
    const skip = new Set(ranked.slice(0, count).map(({ index }) => index))
    return (
      wealth(
        strategy.filter((_, i) => !skip.has(i)),
        compound,
      ) -
      wealth(
        benchmark.filter((_, i) => !skip.has(i)),
        compound,
      )
    )
  })
}

// Standard normal CDF (Abramowitz–Stegun 26.2.17).
const normalCdf = (z: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const tail =
    (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z < 0 ? tail : 1 - tail
}

const normalQuantile = (p: number) => {
  let lo = -10
  let hi = 10
  for (let step = 0; step < 48; step++) {
    const mid = (lo + hi) / 2
    if (normalCdf(mid) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export const expectedMaximumSharpe = (dailySharpes: readonly number[], trials = dailySharpes.length) => {
  if (trials < 2 || dailySharpes.length < 2) return null
  const eulerGamma = 0.5772156649015329
  const expected =
    (1 - eulerGamma) * normalQuantile(1 - 1 / trials) + eulerGamma * normalQuantile(1 - 1 / (trials * Math.E))
  const deviation = sampleDeviation(dailySharpes)
  return Number.isFinite(deviation) ? Math.max(0, expected * deviation) : null
}

/** Probability of exceeding a multiple-trial benchmark expressed as a nonannualized Sharpe. */
export const deflatedSharpe = (values: readonly number[], benchmark: number | null) => {
  const observed = dailySharpe(values)
  if (observed === null || benchmark === null || !Number.isFinite(benchmark)) return null
  const center = mean(values)
  const deviations = values.map((value) => value - center)
  const variance = mean(deviations.map((value) => value ** 2))
  const skew = mean(deviations.map((value) => value ** 3)) / variance ** 1.5
  const kurtosis = mean(deviations.map((value) => value ** 4)) / variance ** 2
  const adjustment = 1 - skew * observed + ((kurtosis - 1) * observed ** 2) / 4
  return adjustment > 0
    ? normalCdf(((observed - benchmark) * Math.sqrt(values.length - 1)) / Math.sqrt(adjustment))
    : null
}

export interface StationaryProtocol {
  readonly draws: number
  readonly meanBlock: number
  readonly seed: number
}

export enum StationarySampling {
  LeftTail,
  // Wave 6C registered the opposite geometric tail and half-unit offset in the PRNG conversion.
  RightTailMidpoint,
}

/** Circular Politis–Romano resampling. Reuse the schedule for both legs of any paired comparison. */
export const stationaryBootstrap = (
  sessions: number,
  { draws, meanBlock, seed }: StationaryProtocol,
  sampling = StationarySampling.LeftTail,
) => {
  if (
    !Number.isSafeInteger(sessions) ||
    sessions <= 0 ||
    !Number.isSafeInteger(draws) ||
    draws <= 0 ||
    sessions * draws * 2 > 0xffff_ffff ||
    !Number.isFinite(meanBlock) ||
    meanBlock < 1 ||
    !Number.isInteger(seed) ||
    seed <= 0 ||
    seed > 0xffff_ffff
  )
    throw new Error('Invalid stationary bootstrap protocol or session count')
  const midpoint = sampling === StationarySampling.RightTailMidpoint
  let state = seed
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) + (midpoint ? 0.5 : 0)) / 2 ** 32
  }
  const logContinue = Math.log1p(-1 / meanBlock)
  // Store start and exclusive end for each block, with offsets into the array per draw.
  const blocks: number[] = []
  const offsets = new Uint32Array(draws + 1)
  for (let draw = 0; draw < draws; draw++) {
    let remaining = sessions
    while (remaining > 0) {
      const start = Math.floor(random() * sessions)
      const u = random()
      const length = Math.min(remaining, 1 + Math.floor((midpoint ? Math.log(u) : Math.log1p(-u)) / logContinue))
      blocks.push(start, start + length)
      remaining -= length
    }
    offsets[draw + 1] = blocks.length
  }
  return { sessions, draws, blocks: Uint32Array.from(blocks), offsets }
}

export type StationaryPlan = ReturnType<typeof stationaryBootstrap>

export enum StationaryCentering {
  BeforeSum,
  // Wave 4E subtracts the mean after adding each observation to the circular prefix.
  AfterSum,
}

/** One-sided test for a positive mean on a complete (optionally paired-excess) series. */
export const stationaryMeanP = (
  values: readonly number[],
  plan: StationaryPlan,
  centering = StationaryCentering.BeforeSum,
) => {
  const n = values.length
  if (n !== plan.sessions) throw new Error('Stationary bootstrap length mismatch')
  if (n < 2 || values.every((value) => value === values[0]) || values.some((value) => !Number.isFinite(value)))
    return null
  const observed = sum(values)
  const center = observed / n
  const prefix = new Float64Array(2 * n + 1)
  for (let i = 0; i < 2 * n; i++) {
    const value = values[i % n]
    prefix[i + 1] =
      centering === StationaryCentering.AfterSum ? prefix[i] + value - center : prefix[i] + (value - center)
  }
  let hits = 0
  for (let draw = 0; draw < plan.draws; draw++) {
    let resampled = 0
    for (let i = plan.offsets[draw]; i < plan.offsets[draw + 1]; i += 2)
      resampled += prefix[plan.blocks[i + 1]] - prefix[plan.blocks[i]]
    if (resampled >= observed) hits++
  }
  return (hits + 1) / (plan.draws + 1)
}
