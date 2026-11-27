export const capital = 100_000
export const grossCap = 180_000
export const targetGross = 150_000
export const costs = [5, 10, 20] as const
export const gateCosts = [10, 20] as const
export const splits = {
  train: ['2016-01-04', '2021-12-31'],
  validation: ['2022-01-03', '2023-12-29'],
  holdout: ['2024-01-02', '2026-11-25'],
} as const
export const sectors = ['XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB'] as const
export type Sector = (typeof sectors)[number]

export const assetClasses = [
  ['SPY', 'QQQ', 'IWM', 'SMH'],
  sectors.filter((sector) => sector !== 'XLRE'),
  ['TLT', 'IEF', 'SHY'],
  ['HYG', 'LQD'],
  ['GLD', 'SLV', 'USO', 'DBC'],
  ['EFA', 'EEM'],
  ['VNQ', 'XLRE'],
]
export const etfs = assetClasses.flat()

export type Sleeves = {
  momentum: { regression: number; lookback: number; skip: number; cycle: number; book: string }
  trend: { weighting: 'atr' | 'vol'; mode: 'long-short' | 'long-only'; deadband: number }
  reversal: { lookback: number; cycle: number }
  defensive: { metric: 'vol' | 'beta'; depth: number }
}
export type Sleeve = keyof Sleeves
type TrialOf<K extends Sleeve> = { family: K; config: Sleeves[K]; id: string }
export type Trial = { [K in Sleeve]: TrialOf<K> }[Sleeve]
export const families = ['momentum', 'trend', 'reversal', 'defensive'] as const satisfies Sleeve[]

const trial = <K extends Sleeve>(family: K, config: Sleeves[K]): TrialOf<K> => ({
  family,
  config,
  id: [family, ...Object.values(config)].join('-'),
})

export function grid(): Trial[] {
  const trials: Trial[] = []
  for (const regression of [60, 120, 252])
    for (const lookback of [60, 120, 180])
      for (const skip of [5, 10, 21])
        for (const cycle of [5, 10, 21])
          for (const book of ['sector-1', 'sector-2', 'cross-10', 'cross-15'])
            trials.push(trial('momentum', { regression, lookback, skip, cycle, book }))
  for (const weighting of ['atr', 'vol'] as const)
    for (const mode of ['long-short', 'long-only'] as const)
      for (const deadband of [0, 0.25, 0.5]) trials.push(trial('trend', { weighting, mode, deadband }))
  for (const lookback of [3, 5]) for (const cycle of [3, 5]) trials.push(trial('reversal', { lookback, cycle }))
  for (const metric of ['vol', 'beta'] as const)
    for (const depth of [10, 15]) trials.push(trial('defensive', { metric, depth }))
  return trials
}

export function neighbors(center: Trial, trials: readonly Trial[]): Trial[] {
  return trials.filter((candidate) => {
    if (candidate.family !== center.family || candidate.id === center.id) return false
    const source = Object.entries(center.config)
    const destination = Object.values(candidate.config)
    const changed = source.flatMap(([key, value], i) => (value === destination[i] ? [] : [{ key, value, i }]))
    if (changed.length !== 1) return false
    const { key, value, i } = changed[0]
    const levels = [...new Set(trials.filter((t) => t.family === center.family).map((t) => Object.values(t.config)[i]))]
    if (key === 'book' && String(value).split('-')[0] !== String(destination[i]).split('-')[0]) return false
    return Math.abs(levels.indexOf(value) - levels.indexOf(destination[i])) === 1
  })
}
