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

export const grossCap = 1.8
export const costs = [5, 10, 20] as const
export const sellFee = 0.21 / 10_000
export const borrow = 0.015
export const annualDays = 252

export type Trial =
  | { kind: 'trend'; direction: 'long' | 'signed'; horizon: 20 | 60 | 120 | 200 | 'vote'; vol: number }
  | { kind: 'pension'; signal: number; threshold: number; direction: 'long' | 'spread' }
  | { kind: 'tom'; entry: number; through: number; filter: 'none' | 'sma200'; vol: number }
  | { kind: 'pullback'; trend: 100 | 200; entry: 'rsi10' | 'rsi15' | 'atr'; exit: 'sma5' | 'rsi70'; hedge: boolean }
  | { kind: 'rotation'; horizon: 20 | 60 | 120; filter: 'credit' | 'equity'; includeIwm: boolean }

export const frozenArms = [
  { kind: 'trend', direction: 'signed', horizon: 120, vol: 0.1 },
  { kind: 'pension', signal: -5, threshold: 0.02, direction: 'long' },
  { kind: 'tom', entry: -2, through: 4, filter: 'none', vol: 0.15 },
  { kind: 'pullback', trend: 100, entry: 'rsi15', exit: 'rsi70', hedge: false },
  { kind: 'rotation', horizon: 120, filter: 'credit', includeIwm: false },
] as const satisfies readonly Trial[]
