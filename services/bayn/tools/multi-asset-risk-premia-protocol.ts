export const etfs = [
  'SPY',
  'QQQ',
  'IWM',
  'SMH',
  'XLK',
  'XLF',
  'XLV',
  'XLY',
  'XLC',
  'XLI',
  'XLP',
  'XLE',
  'XLU',
  'XLRE',
  'XLB',
  'TLT',
  'IEF',
  'SHY',
  'HYG',
  'LQD',
  'GLD',
  'SLV',
  'USO',
  'DBC',
  'EFA',
  'EEM',
  'VNQ',
] as const
export type Etf = (typeof etfs)[number]
export const indexOf = (symbol: Etf) => etfs.indexOf(symbol)

export const splits = {
  train: ['2016-01-04', '2021-12-31', 1511],
  validation: ['2022-01-03', '2023-12-29', 501],
  holdout: ['2024-01-02', '2026-11-25', 729],
} as const
export type Split = keyof typeof splits
export const equity = 100_000
export const grossCap = 1.8
export const costs = [5, 10, 20] as const
export const sellFee = 0.21 / 10_000
export const borrow = 0.015
export const annualDays = 252
export const blockTrials = 10_000
export const basketNames = ['trend', 'pension', 'tom', 'pullback', 'rotation'] as const

export type Trial =
  | { kind: 'trend'; direction: 'long' | 'signed'; horizon: 20 | 60 | 120 | 200 | 'vote'; vol: number }
  | { kind: 'pension'; signal: number; threshold: number; direction: 'long' | 'spread' }
  | { kind: 'tom'; entry: number; through: number; filter: 'none' | 'sma200'; vol: number }
  | { kind: 'pullback'; trend: 100 | 200; entry: 'rsi10' | 'rsi15' | 'atr'; exit: 'sma5' | 'rsi70'; hedge: boolean }
  | { kind: 'rotation'; horizon: 20 | 60 | 120; filter: 'credit' | 'equity'; includeIwm: boolean }

export const id = (trial: Trial) => Object.values(trial).join('/')

export function* trials(): Generator<Trial> {
  for (const direction of ['long', 'signed'] as const)
    for (const horizon of [20, 60, 120, 200, 'vote'] as const)
      for (const vol of [0.1, 0.12, 0.15]) yield { kind: 'trend', direction, horizon, vol }

  for (const signal of [-5, -4, -3])
    for (const threshold of [0.02, 0.03])
      for (const direction of ['long', 'spread'] as const) yield { kind: 'pension', signal, threshold, direction }

  for (const entry of [-2, -1])
    for (const through of [3, 4])
      for (const filter of ['none', 'sma200'] as const)
        for (const vol of [0.1, 0.12, 0.15]) yield { kind: 'tom', entry, through, filter, vol }

  for (const trend of [100, 200] as const)
    for (const entry of ['rsi10', 'rsi15', 'atr'] as const)
      for (const exit of ['sma5', 'rsi70'] as const)
        for (const hedge of [false, true]) yield { kind: 'pullback', trend, entry, exit, hedge }

  for (const horizon of [20, 60, 120] as const)
    for (const filter of ['credit', 'equity'] as const)
      for (const includeIwm of [false, true]) yield { kind: 'rotation', horizon, filter, includeIwm }
}

export const neighbors = (trial: Trial, grid: readonly Trial[]) =>
  grid.filter((other) => {
    if (other.kind !== trial.kind) return false
    const fields = Object.entries(trial)
    const changed = fields.filter(([key, value]) => !Object.entries(other).some(([k, v]) => k === key && v === value))
    if (changed.length !== 1) return false
    const [key, value] = changed[0]
    const otherValue = Object.entries(other).find(([k]) => k === key)?.[1]
    const levels = [
      ...new Set(
        grid.filter((row) => row.kind === trial.kind).map((row) => Object.entries(row).find(([k]) => k === key)?.[1]),
      ),
    ]
    return Math.abs(levels.indexOf(value) - levels.indexOf(otherValue)) === 1
  })
