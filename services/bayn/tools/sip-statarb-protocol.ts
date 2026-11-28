export const firstDay = '2024-01-02'
export const trainEnd = '2025-06-30'
export const validationEnd = '2026-03-31'
export const lastDay = '2026-11-25'
export const capitalUsd = 100_000
export const grossCapUsd = 180_000
export const sellFeeBps = 0.21
export const costs = [2, 5, 10] as const
export const gateCosts = [5, 10] as const
export const signals = ['spy', 'median', 'sector', 'from-open', 'vwap-z'] as const
export const clocks = [12, 18, 24, 30, 36, 42] as const // 5m slots since 09:30 ET

export const listingStarts: Readonly<Record<string, string>> = {
  ALAB: '2024-03-20',
  GEV: '2024-04-02',
  SNDK: '2025-02-24',
}
export const wdcReset = '2025-02-24'

export const sectorGroups = {
  SMH: 'ALAB AMD AMAT ARM ASML AVGO COHR CRDO INTC KLAC LITE LRCX MRVL MU NVDA SMCI SNDK TSM WDC',
  XLK: 'AAPL ANET APP CRWD MSFT NET NOW ORCL PANW PLTR SNOW VRT',
  QQQ: 'GOOGL META NFLX SPOT',
  XLY: 'AMZN SHOP TSLA UBER',
  XLF: 'HOOD SOFI',
  ARKK: 'COIN MSTR',
  XLI: 'CEG GEV VST',
} as const

export type Universe = 'bayn17-stocks' | 'bayn18-mixed' | 'expanded46-stocks' | 'expanded50-mixed'
export type Cost = (typeof costs)[number]
export type Signal = (typeof signals)[number]
export interface Trial {
  readonly universe: Universe
  readonly signal: Signal
  readonly pairs: number
  readonly entry: number
  readonly timing: 'single' | 'two-wave'
  readonly exit: 'wide' | 'atr' | 'cross' | 'timed'
  readonly sizing: 'equal' | 'inverse-vol' | 'nagel' | 'moreira-muir'
  readonly gateBps: number
}

export const trialId = (t: Trial) =>
  [t.universe, t.signal, t.pairs, t.entry, t.timing, t.exit, t.sizing, t.gateBps].join('/')

export const buildTrials = (): readonly Trial[] => {
  const base: Trial = {
    universe: 'expanded46-stocks',
    signal: 'spy',
    pairs: 2,
    entry: 30,
    timing: 'single',
    exit: 'wide',
    sizing: 'equal',
    gateBps: 0,
  }
  const trials: Trial[] = []
  for (const universe of ['bayn17-stocks', 'bayn18-mixed'] as const)
    for (const entry of clocks) trials.push({ ...base, universe, entry })
  for (const pairs of [2, 3, 4, 5, 6]) trials.push({ ...base, universe: 'expanded50-mixed', pairs })
  for (const signal of signals) {
    for (const pairs of [2, 3, 4, 5, 6]) {
      for (const entry of clocks) trials.push({ ...base, signal, pairs, entry })
    }
    for (const pairs of [3, 4, 5]) {
      const anchor = { ...base, signal, pairs }
      for (const exit of ['atr', 'cross', 'timed'] as const) trials.push({ ...anchor, exit })
      for (const sizing of ['inverse-vol', 'nagel', 'moreira-muir'] as const) trials.push({ ...anchor, sizing })
      for (const gateBps of [35, 50, 75]) trials.push({ ...anchor, gateBps })
      for (const entry of [6, 12, 18]) trials.push({ ...anchor, entry, timing: 'two-wave' })
    }
  }
  return trials
}

export const neighborPairs = (trial: Trial) => [
  { axis: 'clock', ids: [-6, 6].map((delta) => trialId({ ...trial, entry: trial.entry + delta })) },
  { axis: 'depth', ids: [-1, 1].map((delta) => trialId({ ...trial, pairs: trial.pairs + delta })) },
]

export const halves = [
  { id: '2024H1', from: firstDay, through: '2024-06-30' },
  { id: '2024H2', from: '2024-07-01', through: '2024-12-31' },
  { id: '2025H1', from: '2025-01-01', through: trainEnd },
  { id: '2025H2', from: '2025-07-01', through: '2025-12-31' },
  { id: '2026H1', from: '2026-01-01', through: '2026-06-30' },
  { id: '2026H2', from: '2026-07-01', through: lastDay },
] as const

export const slices = [
  { id: 'train', from: firstDay, through: trainEnd },
  { id: 'validation', from: '2025-07-01', through: validationEnd },
  { id: 'holdout', from: '2026-04-01', through: lastDay },
  { id: 'all', from: firstDay, through: lastDay },
  ...halves,
] as const
