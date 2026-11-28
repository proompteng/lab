export const end = '2026-11-25'
export const capital = 180_000
export const costs = [2, 5, 10] as const
export const sellFee = 0.21 / 10_000
export const annualBorrow = 0.015
export const priorSessions = 20
export const pairWindows = [20, 40] as const
export const zEntries = [1.5, 2, 2.5] as const
export const pairFilters = ['none', 'half-life', 'correlation'] as const
export const gapThresholds = [1.5, 2] as const
export const gapHorizons = [1, 3] as const
export const swingHolds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
export const gapHolds = [1, 2, 3, 4, 5] as const
export const rvolMinimum = 2.5

export const pairs = [
  ['KLAC', 'LRCX'],
  ['LRCX', 'AMAT'],
  ['KLAC', 'AMAT'],
  ['ASML', 'TSM'],
  ['COHR', 'LITE'],
  ['MU', 'WDC'],
  ['NVDA', 'AMD'],
  ['AVGO', 'MRVL'],
  ['AMD', 'MRVL'],
  ['NVDA', 'AVGO'],
  ['PANW', 'CRWD'],
  ['NOW', 'ORCL'],
  ['NET', 'SNOW'],
  ['VST', 'CEG'],
  ['VRT', 'GEV'],
  ['COIN', 'MSTR'],
  ['HOOD', 'SOFI'],
  ['MSFT', 'GOOGL'],
  ['AAPL', 'MSFT'],
  ['QQQ', 'XLK'],
  ['SMH', 'XLK'],
  ['QQQ', 'SPY'],
  ['TLT', 'IEF'],
] as const

export const listing: Readonly<Record<string, string>> = {
  COIN: '2021-04-14',
  APP: '2021-04-15',
  HOOD: '2021-07-29',
  SOFI: '2021-06-01',
  META: '2022-06-09',
  COHR: '2022-09-08',
  CRDO: '2022-01-27',
  CEG: '2022-02-02',
  ARM: '2023-09-14',
  ALAB: '2024-03-20',
  GEV: '2024-04-02',
  SNDK: '2025-02-24',
}
// The old WDC and the post-distribution instrument are not a continuous split-adjusted series.
export const wdcReset = '2025-02-24'
export const wdcFlatten = '2025-02-21'
export const coreEtfs = new Set(['IWM', 'QQQ', 'SMH', 'SPY'])

export const splits = {
  intraday: [
    { id: 'train', from: '2024-01-02', to: '2025-06-30' },
    { id: 'validation', from: '2025-07-01', to: '2026-03-31' },
    { id: 'holdout', from: '2026-04-01', to: end },
  ],
  daily: [
    { id: 'train', from: '2021-01-04', to: '2024-06-30' },
    { id: 'validation', from: '2024-07-01', to: '2025-08-31' },
    { id: 'holdout', from: '2025-09-01', to: end },
  ],
} as const
export type Frequency = keyof typeof splits
export type Range = { readonly id: string; readonly from: string; readonly to: string }
export const windows = (frequency: Frequency) => [
  ...splits[frequency],
  { id: 'all', from: splits[frequency][0].from, to: end },
  ...Array.from({ length: frequency === 'daily' ? 6 : 3 }, (_, i) => {
    const y = String((frequency === 'daily' ? 2021 : 2024) + i)
    return [
      { id: y, from: y + '-01-01', to: y + '-12-31' },
      { id: y + 'H1', from: y + '-01-01', to: y + '-06-30' },
      { id: y + 'H2', from: y + '-07-01', to: y + '-12-31' },
    ]
  }).flat(),
]

type PairParams = { lookback: number; z: number; filter: (typeof pairFilters)[number] }
type GapParams = { gap: number; universe: 'stocks' | 'core' }
type PairIntraday = PairParams & { engine: 'pair-intraday' }
type PairDaily = PairParams & { engine: 'pair-swing'; hold: number }
type GapIntraday = GapParams & { engine: 'gap-intraday'; horizon: (typeof gapHorizons)[number] }
type GapDaily = GapParams & { engine: 'gap-swing'; hold: number }
type GapFade = GapParams & { engine: 'gap-fade'; target: 'vwap' | 'prior-close' }
export type Params = PairIntraday | PairDaily | GapIntraday | GapDaily | GapFade
export type Trial = Params & { id: string; frequency: Frequency }

export const trials: readonly Trial[] = (() => {
  const records: Trial[] = []
  const add = (p: Params, frequency: Frequency) => {
    records.push({ ...p, frequency, id: Object.values(p).join(':') })
  }
  for (const lookback of pairWindows)
    for (const z of zEntries)
      for (const filter of pairFilters) {
        add({ engine: 'pair-intraday', lookback, z, filter }, 'intraday')
        for (const hold of swingHolds) add({ engine: 'pair-swing', lookback, z, filter, hold }, 'daily')
      }
  for (const universe of ['stocks', 'core'] as const) {
    for (const gap of gapThresholds) {
      for (const horizon of gapHorizons) add({ engine: 'gap-intraday', gap, horizon, universe }, 'intraday')
      for (const hold of gapHolds) add({ engine: 'gap-swing', gap, hold, universe }, 'daily')
    }
    for (const target of ['vwap', 'prior-close'] as const) {
      add({ engine: 'gap-fade', gap: 2, target, universe }, 'intraday')
    }
  }
  return records
})()

export const neighbors = (trial: Trial) =>
  trials.filter((other) => {
    if (trial.engine !== other.engine) return false
    const differences = Object.entries(trial).filter(
      ([key, value]) => key !== 'id' && Reflect.get(other, key) !== value,
    )
    if (differences.length !== 1) return false
    const [key, value] = differences[0]
    const next: unknown = Reflect.get(other, key)
    if (key === 'universe') return false
    if (key === 'hold' || key === 'z') {
      return typeof value === 'number' && typeof next === 'number' && Math.abs(value - next) === (key === 'z' ? 0.5 : 1)
    }
    return true
  })
