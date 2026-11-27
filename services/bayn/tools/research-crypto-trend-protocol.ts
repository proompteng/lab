export const dayMs = 86_400_000
export const symbols = [
  'BTC/USD',
  'ETH/USD',
  'SOL/USD',
  'LINK/USD',
  'AVAX/USD',
  'LTC/USD',
  'DOGE/USD',
  'AAVE/USD',
  'UNI/USD',
  'XRP/USD',
] as const
export const fees = [50, 30, 20] as const
export const primaryFee = fees[0]
export const venues = {
  '1h': {
    barsPerDay: 24,
    key: 'alpaca_crypto_1h_10sym_20240101_20261126.tsv.gz',
    rows: 248820,
    start: '2024-01-01',
    validation: '2025-07-01',
    holdout: '2026-04-01',
  },
  '1d': {
    barsPerDay: 1,
    key: 'alpaca_crypto_1d_10sym_20220101_20261126.tsv.gz',
    rows: 16772,
    start: '2022-01-01',
    validation: '2024-07-01',
    holdout: '2025-09-01',
  },
} as const
export const end = '2026-11-27'
export type Frame = keyof typeof venues
export const frames: readonly Frame[] = ['1h', '1d']
export const development = ['train', 'validation'] as const
export const splits = [...development, 'holdout'] as const
export type Split = (typeof splits)[number]
export const windows = (frame: Frame) => {
  const { start, validation, holdout } = venues[frame]
  return { train: [start, validation], validation: [validation, holdout], holdout: [holdout, end] } as const
}
export const regimes = {
  bear2022: ['2022-01-01', '2023-01-01'],
  bull2024: ['2024-01-01', '2025-01-01'],
  pullback2026: ['2026-01-01', '2026-04-01'],
} as const
export const bootstrap = { draws: 10_000, days: 7, seed: 0x62736f6c }
export const gate = { maxAnnualTurnover: 24, maxBtcDrawdownRatio: 0.5, maxP: 0.05, neighborSharpeRatio: 0.7 }
export const trend = { volDays: 20, atrHours: 48, resizeDays: 3, relativeBand: 0.2 }
export const momentumBand = 0.1
export const compression = { shortHours: 24, longHours: 168, stopAtr: 3, cooldownHours: 24 }

type Universe = 'core' | 'full'
type Axis = { name: string; index: number }
type Rule =
  | { kind: 'channel'; entry: number; exit: number; stop: number | null; target: number }
  | { kind: 'ema'; fast: number; slow: number; target: number }
  | { kind: 'momentum'; days: number; top: number; filter: 'sma' | 'return'; rebalanceDays: number }
  | { kind: 'parity'; fast: number; slow: number; target: number; btcGate: boolean }
  | { kind: 'compression'; entry: number; exit: number; ratio: number; weekend: boolean }
export type Trial = {
  id: string
  frame: Frame
  universe: Universe
  rule: Rule
  axes: readonly Axis[]
}
export const roster = (universe: Universe) => (universe === 'core' ? symbols.slice(0, 3) : symbols)
const axes = (...pairs: ReadonlyArray<readonly [string, number]>): Axis[] =>
  pairs.map(([name, index]) => ({ name, index }))
const targets = [0.15, 0.2, 0.25]
const channels = [
  [24, 12],
  [72, 36],
  [168, 72],
  [336, 168],
] as const
const averages = [
  [24, 120],
  [48, 240],
  [120, 480],
  [240, 960],
] as const
const parityAverages = [
  [120, 480],
  [240, 960],
  [480, 2400],
  [960, 4800],
] as const

export const registry = (): Trial[] => {
  const trials: Trial[] = []
  for (const frame of frames) {
    const add = (universe: Universe, rule: Rule, dimensions: readonly Axis[]) => {
      const id = [frame, universe, rule.kind, ...dimensions.map(({ name, index }) => `${name}${index}`)].join('-')
      trials.push({ id, frame, universe, rule, axes: dimensions })
    }
    for (const [t, target] of targets.entries()) {
      for (const [h, [entry, exit]] of channels.entries()) {
        for (const [s, stop] of [null, 2.5, 4].entries()) {
          add('full', { kind: 'channel', entry, exit, stop, target }, axes(['h', h], ['s', s], ['v', t]))
        }
      }
      for (const [h, [fast, slow]] of averages.entries()) {
        add('full', { kind: 'ema', fast, slow, target }, axes(['h', h], ['v', t]))
      }
      for (const universe of ['core', 'full'] as const) {
        for (const [h, [fast, slow]] of parityAverages.entries()) {
          for (const [b, btcGate] of [false, true].entries()) {
            add(universe, { kind: 'parity', fast, slow, target, btcGate }, axes(['h', h], ['v', t], ['b', b]))
          }
        }
      }
    }
    for (const [h, days] of [7, 14, 21, 30].entries()) {
      for (const [k, top] of [2, 3].entries()) {
        for (const [a, filter] of (['sma', 'return'] as const).entries()) {
          for (const [r, rebalanceDays] of [3, 7].entries()) {
            add(
              'full',
              { kind: 'momentum', days, top, filter, rebalanceDays },
              axes(['h', h], ['k', k], ['a', a], ['r', r]),
            )
          }
        }
      }
    }
    if (frame === '1h') {
      for (const universe of ['core', 'full'] as const) {
        for (const [h, [entry, exit]] of channels.slice(0, 3).entries()) {
          for (const [c, ratio] of [0.6, 0.8].entries()) {
            for (const [w, weekend] of [false, true].entries()) {
              add(universe, { kind: 'compression', entry, exit, ratio, weekend }, axes(['h', h], ['c', c], ['w', w]))
            }
          }
        }
      }
    }
  }
  return trials
}

export const neighbors = (trial: Trial, trials: readonly Trial[]) =>
  trials.filter(
    (other) =>
      trial.frame === other.frame &&
      trial.universe === other.universe &&
      trial.rule.kind === other.rule.kind &&
      trial.axes.reduce((n, axis, i) => n + Math.abs(axis.index - other.axes[i].index), 0) === 1,
  )

export const dailyPair = (trial: Trial, trials: readonly Trial[]) =>
  trial.frame === '1h' ? trials.find(({ id }) => id === trial.id.replace(/^1h-/, '1d-')) : trial
