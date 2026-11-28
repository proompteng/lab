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
export const costs = [2, 5, 10, 20] as const
export const sellFee = 0.21 / 10_000
export const borrow = 0.015
export const annualDays = 252
export const horizons = [21, 63, 126, 252] as const
export const priorTrials = 122
export const bootstrap = { draws: 10_000, blockDays: 10, seed: 0x7ca4da11 } as const

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

export function* grid(): Generator<Trial> {
  for (const panel of [0, 1] as const)
    for (const protection of ['binary', 'breadth'] as const)
      for (const cadence of [10, 21] as const)
        for (const offensive of [2, 3, 4] as const)
          for (const defensive of [1, 2] as const)
            for (const weighting of ['equal', 'inverseVol'] as const)
              yield { kind: 'canary', panel, protection, cadence, offensive, defensive, weighting }

  for (const book of ['long', 'signed'] as const)
    for (const band of [0.05, 0.1])
      for (const cadence of [5, 10] as const)
        for (const vol of [0.08, 0.1]) yield { kind: 'trend', book, band, cadence, vol }

  for (const horizon of [63, 126] as const) {
    for (const review of [1, 21, 42] as const) yield { kind: 'macro', horizon, review, band: 0.1 }
    for (const cadence of [21, 42] as const)
      for (const top of [2, 3] as const) yield { kind: 'sector', horizon, cadence, top }
  }

  yield mix
  yield { ...mix, cadence: 10 }
  yield { ...mix, cadence: 42 }
  yield { ...mix, band: 0.025 }
  yield { ...mix, band: 0.1 }
  for (const variant of ['offensive2', 'offensive4', 'trend10vol', 'macro126']) yield { ...mix, variant }
}

export const trialId = (trial: Trial) => Object.values(trial).join('/')

export const neighbors = (trial: Trial, trials: readonly Trial[]) =>
  trials
    .filter((other) => {
      if (trial.kind !== other.kind) return false
      const changed = Object.keys(trial).filter((key) => Reflect.get(trial, key) !== Reflect.get(other, key))
      if (changed.length !== 1) return false
      const key = changed[0]
      if (key === 'variant')
        return (
          trial.kind === 'ensemble' &&
          other.kind === 'ensemble' &&
          (trial.variant === 'base' || other.variant === 'base')
        )
      const value: unknown = Reflect.get(trial, key)
      const alternative: unknown = Reflect.get(other, key)
      if (typeof value !== 'number' || typeof alternative !== 'number') return true
      const levels = [
        ...new Set(trials.filter((v) => v.kind === trial.kind).map((v) => Number(Reflect.get(v, key)))),
      ].sort((a, b) => a - b)
      return Math.abs(levels.indexOf(value) - levels.indexOf(alternative)) === 1
    })
    .map(trialId)
