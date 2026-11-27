export const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
export const mean = (values: readonly number[]) => sum(values) / values.length

export const quantile = (values: readonly number[], probability: number): number | null => {
  const ordered = values.toSorted((a, b) => a - b)
  const index = (ordered.length - 1) * probability
  const lower = ordered[Math.floor(index)]
  const upper = ordered[Math.ceil(index)]
  return lower === undefined || upper === undefined ? null : lower + (upper - lower) * (index % 1)
}

const sampleDeviation = (values: readonly number[]) => {
  const center = mean(values)
  return Math.sqrt(sum(values.map((value) => (value - center) ** 2)) / (values.length - 1))
}

export const dailySharpe = (values: readonly number[]) => {
  const deviation = sampleDeviation(values)
  return deviation > 0 ? mean(values) / deviation : null
}

// One-sided test of positive mean P&L. Resample centered 5-session blocks with circular wrap;
// truncate the final block to keep the actual sample size. Reuse the seed for paired comparisons.
export const bootstrapPValue = (values: readonly number[], trials = 10_000) => {
  const blockSize = 5
  const length = values.length
  const center = mean(values)
  const observed = sum(values)
  const remainder = length % blockSize
  const blockSums = (size: number) =>
    values.map((_, index) => {
      let total = 0
      for (let i = 0; i < size; i++) total += (values[(index + i) % length] ?? 0) - center
      return total
    })
  const fullBlocks = blockSums(blockSize)
  const lastBlocks = blockSums(remainder)
  let state = 0x4d494444
  const draw = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return Math.floor((state / 2 ** 32) * length)
  }
  let extreme = 0
  for (let trial = 0; trial < trials; trial++) {
    let total = 0
    for (let block = 0; block < Math.floor(length / blockSize); block++) total += fullBlocks[draw()] ?? 0
    if (remainder > 0) total += lastBlocks[draw()] ?? 0
    if (total >= observed) extreme++
  }
  return (extreme + 1) / (trials + 1)
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

export const expectedMaximumStandardNormal = (n: number) => {
  if (n < 2) return null
  const eulerGamma = 0.5772156649015329
  return (1 - eulerGamma) * normalQuantile(1 - 1 / n) + eulerGamma * normalQuantile(1 - 1 / (n * Math.E))
}

export const expectedMaximumSharpe = (dailySharpes: readonly number[], trialCount = dailySharpes.length) => {
  const expectedMaximum = expectedMaximumStandardNormal(trialCount)
  return expectedMaximum === null || dailySharpes.length < 2
    ? null
    : Math.max(0, expectedMaximum * sampleDeviation(dailySharpes))
}

export const deflatedSharpe = (values: readonly number[], benchmark: number | null) => {
  const sharpe = dailySharpe(values)
  if (sharpe === null || benchmark === null) return null
  const center = mean(values)
  const deviations = values.map((value) => value - center)
  const variance = mean(deviations.map((value) => value ** 2))
  const skew = mean(deviations.map((value) => value ** 3)) / variance ** 1.5
  const kurtosis = mean(deviations.map((value) => value ** 4)) / variance ** 2
  const adjustment = 1 - skew * sharpe + ((kurtosis - 1) * sharpe ** 2) / 4
  return adjustment > 0
    ? normalCdf(((sharpe - benchmark) * Math.sqrt(values.length - 1)) / Math.sqrt(adjustment))
    : null
}

export const sessionEconomics = (daily: readonly (number | null)[]) => {
  const complete = daily.filter((value) => value !== null)
  const resolved = complete.length === daily.length
  const sharpe = resolved ? dailySharpe(complete) : null
  const folds = [0, 22, 44].map((offset) => {
    const fold = daily.slice(offset, offset + 22)
    return fold.some((value) => value === null) ? null : sum(fold.filter((value) => value !== null))
  })
  return {
    netUsd: resolved ? sum(complete) : null,
    sharpeAnnualized: sharpe === null ? null : sharpe * Math.sqrt(252),
    exTop5Usd: resolved ? sum(complete.toSorted((a, b) => b - a).slice(5)) : null,
    foldNetUsd: folds,
    bootstrapPValue: resolved ? bootstrapPValue(complete) : null,
  }
}
