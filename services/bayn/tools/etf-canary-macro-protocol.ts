export const etfs = [
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  'XLK',
  'XLF',
  'XLE',
  'XLV',
  'XLI',
  'XLP',
  'XLU',
  'XLY',
  'XLB',
  'XLC',
  'XLRE',
  'TLT',
  'IEF',
  'SHY',
  'HYG',
  'LQD',
  'GLD',
  'SLV',
  'DBC',
  'USO',
  'UUP',
  'EFA',
  'EEM',
] as const

export type Etf = (typeof etfs)[number]
export const asset = (symbol: Etf) => etfs.indexOf(symbol)
export const shy = asset('SHY')
export const spy = asset('SPY')
export const splits = {
  train: ['2016-01-04', '2021-12-31', 1511],
  validation: ['2022-01-03', '2023-12-29', 501],
  holdout: ['2024-01-02', '2026-11-25', 729],
} as const
export const sellFee = 0.21 / 10_000
export const borrow = 0.015
export const annualDays = 252
export const horizons = [21, 63, 126, 252] as const

export const canaries = [
  ['EEM', 'HYG', 'IEF', 'TLT'],
  ['EEM', 'LQD', 'IEF'],
] as const
export const offense = ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'GLD', 'DBC', 'XLK', 'XLE', 'XLF', 'XLV'] as const
export const defense = ['SHY', 'IEF', 'TLT', 'GLD', 'UUP', 'DBC'] as const
export const trendSleeves = [
  ['SPY', 'QQQ', 'EFA', 'EEM'],
  ['TLT', 'IEF'],
  ['HYG', 'LQD'],
  ['GLD', 'SLV', 'DBC'],
  ['UUP'],
] as const
export const regimes = [
  ['QQQ', 'SPY', 'XLK', 'IEF'],
  ['XLE', 'DBC', 'GLD', 'XLI', 'SPY'],
  ['UUP', 'GLD', 'DBC', 'SHY'],
  ['TLT', 'IEF', 'GLD', 'SHY'],
] as const
export const sectors = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLP', 'XLU', 'XLY', 'XLB', 'XLC', 'XLRE'] as const
export const defensiveSectors = ['XLV', 'XLP', 'XLU'] as const

export type Canary = {
  kind: 'canary'
  panel: 0 | 1
  protection: 'binary' | 'breadth'
  cadence: 10 | 21
  offensive: 2 | 3 | 4
  defensive: 1 | 2
  weighting: 'equal' | 'inverseVol'
}
type Trend = { kind: 'trend'; book: 'long' | 'signed'; band: number; cadence: 5 | 10; vol: number }
type Macro = { kind: 'macro'; horizon: 63 | 126; review: 1 | 21 | 42; band: 0.1 }
type Sector = { kind: 'sector'; horizon: 63 | 126; cadence: 21 | 42; top: 2 | 3 }
type Ensemble = { kind: 'ensemble'; variant: string; cadence: 10 | 21 | 42; band: number }
export type Trial = Canary | Trend | Macro | Sector | Ensemble
export type Standalone = Exclude<Trial, Ensemble>

export const ensembleCanary = {
  kind: 'canary',
  panel: 0,
  protection: 'breadth',
  cadence: 21,
  offensive: 3,
  defensive: 2,
  weighting: 'inverseVol',
} as const satisfies Canary
export const ensembleTrend = { kind: 'trend', book: 'long', band: 0.1, cadence: 10, vol: 0.08 } as const satisfies Trend
export const ensembleMacro = { kind: 'macro', horizon: 63, review: 21, band: 0.1 } as const satisfies Macro
export const mix = { kind: 'ensemble', variant: 'base', cadence: 21, band: 0.05 } as const satisfies Ensemble
