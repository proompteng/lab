export const costs = [2, 5, 10] as const
export const stressCosts = [5, 10] as const
export const equity = 100_000
export const grossCap = 180_000
export const sellFee = 0.21 / 10_000
export const historySessions = 14
export const allocationLookback = 20
export const trainEnd = '2025-06-30'
export const validationEnd = '2026-03-31'
export const firstDay = '2024-01-02'
export const lastDay = '2026-11-25'

export const windows = {
  train: [firstDay, trainEnd, 374],
  validation: ['2025-07-01', validationEnd, 189],
  holdout: ['2026-04-01', lastDay, 166],
  '2024H1': [firstDay, '2024-06-30', 124],
  '2024H2': ['2024-07-01', '2024-12-31', 128],
  '2025H1': ['2025-01-01', trainEnd, 122],
  '2025H2': ['2025-07-01', '2025-12-31', 128],
  '2026H1': ['2026-01-01', '2026-06-30', 123],
  '2026H2': ['2026-07-01', lastDay, 104],
  all: [firstDay, lastDay, 729],
} as const
export type Window = keyof typeof windows
export const halfYears = ['2024H1', '2024H2', '2025H1', '2025H2', '2026H1', '2026H2'] as const

export const stocks = (
  'NVDA AMD MU AVGO COHR LITE MRVL WDC SNDK TSLA META GOOGL MSFT AAPL AMZN INTC NFLX PLTR MSTR COIN SMCI ARM ANET ' +
  'PANW CRWD NET APP HOOD SOFI VRT VST CEG GEV ALAB CRDO KLAC LRCX AMAT ASML TSM ORCL NOW SNOW UBER SHOP SPOT'
)
  .split(' ')
  .sort()
export const symbols = [
  ...stocks,
  ...'SPY QQQ SMH IWM XLF XLE XLK XLV XLI XLY XBI ARKK TLT IEF GLD USO'.split(' '),
].sort()
export const noiseSymbols = ['QQQ', 'SMH'] as const
export const listings: Readonly<Record<string, string>> = {
  ALAB: '2024-03-20',
  GEV: '2024-04-02',
  SNDK: '2025-02-24',
}

export type Orb = { engine: 'orb'; id: string; top: number; rvol: number; target: 2 | 3 | 'eod' }
export type Reversion = {
  engine: 'reversion'
  id: string
  signalSlot: number
  gate: 'spread' | 'iqr'
  minBps: number
  exit: 'wide' | 'eod'
}
export type Noise = { engine: 'noise'; id: string; band: number; exit: 'opposite' | 'atr' }
export type Sleeve = Orb | Reversion | Noise
export type Weight = (typeof weights)[number]
export type Portfolio = {
  engine: 'portfolio'
  id: string
  orb: Orb
  reversion: Reversion
  noise: Noise | null
  weight: Weight
}
export type Trial = Sleeve | Portfolio

export const orbTrials = [1, 2, 3].flatMap((top) =>
  [2, 2.5, 3].flatMap((rvol) =>
    ([2, 3, 'eod'] as const).map(
      (target): Orb => ({
        engine: 'orb',
        id: `orb/k${top}/${rvol}/${target}`,
        top,
        rvol,
        target,
      }),
    ),
  ),
)
export const reversionTrials = [23, 29, 35].flatMap((signalSlot) =>
  (
    [
      ['spread', [0, 200, 300, 400, 500, 600]],
      ['iqr', [50, 75, 100]],
    ] as const
  ).flatMap(([gate, thresholds]) =>
    thresholds.flatMap((minBps) =>
      (['wide', 'eod'] as const).map(
        (exit): Reversion => ({
          engine: 'reversion',
          id: `reversion/${signalSlot}/${gate}/${minBps}/${exit}`,
          signalSlot,
          gate,
          minBps,
          exit,
        }),
      ),
    ),
  ),
)
export const noiseTrials = [1, 1.2].flatMap((band) =>
  (['opposite', 'atr'] as const).map((exit): Noise => ({ engine: 'noise', id: `noise/${band}/${exit}`, band, exit })),
)
export const sleeves = [...orbTrials, ...reversionTrials, ...noiseTrials]
export const orbControl = 'orb/k1/2.5/2'
export const reversionControl = 'reversion/29/spread/0/wide'
export const noiseControl = 'noise/1.2/opposite'
const weights = ['equal', 'orb-tilt', 'reversion-tilt', 'inverse-variance', 'risk-parity'] as const

export const portfolios = (orbs: readonly Orb[], reversions: readonly Reversion[]): Portfolio[] =>
  orbs.flatMap((orb) =>
    reversions.flatMap((reversion) =>
      [null, ...noiseTrials].flatMap((noise) =>
        weights.map(
          (weight): Portfolio => ({
            engine: 'portfolio',
            id: `${orb.id}+${reversion.id}+${noise?.id ?? 'none'}/${weight}`,
            orb,
            reversion,
            noise,
            weight,
          }),
        ),
      ),
    ),
  )
