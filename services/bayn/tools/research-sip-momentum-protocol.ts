export const costs = [2, 5, 10] as const
export const equity = 100_000
export const grossCap = 180_000
export const sellFee = 0.21 / 10_000
export const historySessions = 14
export const trainEnd = '2025-06-30'
export const validationEnd = '2026-03-31'
export const firstDay = '2024-01-02'
export const lastDay = '2026-11-25'

export const stocks = (
  'NVDA AMD MU AVGO COHR LITE MRVL WDC SNDK TSLA META GOOGL MSFT AAPL AMZN INTC NFLX PLTR MSTR COIN SMCI ARM ANET ' +
  'PANW CRWD NET APP HOOD SOFI VRT VST CEG GEV ALAB CRDO KLAC LRCX AMAT ASML TSM ORCL NOW SNOW UBER SHOP SPOT'
)
  .split(' ')
  .sort()
export const etfs = 'SPY QQQ SMH IWM XLF XLE XLK XLV XLI XLY XBI ARKK TLT IEF GLD USO'.split(' ').sort()
export const symbols = [...stocks, ...etfs].sort()
export const listings: Readonly<Record<string, string>> = {
  ALAB: '2024-03-20',
  GEV: '2024-04-02',
  SNDK: '2025-02-24',
}

export const universes = {
  pair: ['QQQ', 'SMH'],
  sectors: ['QQQ', 'SMH', 'XLE', 'XLF', 'XLI', 'XLV'],
  all: etfs,
} as const
export type Universe = keyof typeof universes

const orbAxes = {
  rangeBars: [1, 3],
  rvol: [1.5, 2, 2.5, 3],
  top: [1, 3, 5],
  filter: ['none', 'gap', 'spy'],
  stop: [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 'range'],
  target: ['eod', 2, 5, 10],
} as const
const noiseAxes = {
  universe: ['pair', 'sectors', 'all'],
  checkpoint: [6, 12],
  band: [0.8, 1, 1.2],
  exit: ['atr', 'opposite'],
} as const

type Levels<A extends Record<string, readonly unknown[]>> = { [K in keyof A]: A[K][number] }
export type Orb = { id: string; engine: 'orb' } & Levels<typeof orbAxes>
export type Noise = { id: string; engine: 'noise' } & Levels<typeof noiseAxes>
export type Sleeve = Orb | Noise
export type Combo = { id: string; engine: 'combo'; orb: Orb; noise: Noise; orbWeight: number }
export type Trial = Sleeve | Combo

export const sleeveTrials: readonly Sleeve[] = [
  ...orbAxes.rangeBars.flatMap((rangeBars) =>
    orbAxes.rvol.flatMap((rvol) =>
      orbAxes.top.flatMap((top) =>
        orbAxes.filter.flatMap((filter) =>
          orbAxes.stop.flatMap((stop) =>
            orbAxes.target.map(
              (target): Orb => ({
                engine: 'orb',
                id: `orb${rangeBars * 5}/${rvol}/k${top}/${filter}/${stop}/${target}`,
                rangeBars,
                rvol,
                top,
                filter,
                stop,
                target,
              }),
            ),
          ),
        ),
      ),
    ),
  ),
  ...noiseAxes.universe.flatMap((universe) =>
    noiseAxes.checkpoint.flatMap((checkpoint) =>
      noiseAxes.band.flatMap((band) =>
        noiseAxes.exit.map(
          (exit): Noise => ({
            engine: 'noise',
            id: `noise/${universe}/${checkpoint * 5}/${band}/${exit}`,
            universe,
            checkpoint,
            band,
            exit,
          }),
        ),
      ),
    ),
  ),
]

const orbStopNeighbors = orbAxes.stop.filter((v) => typeof v === 'number')
const orbTargetNeighbors = [2, 5, 10, 'eod'] as const

export const neighbors = (trial: Sleeve, registry: readonly Sleeve[] = sleeveTrials) => {
  const axes = trial.engine === 'orb' ? { ...orbAxes, stop: orbStopNeighbors, target: orbTargetNeighbors } : noiseAxes
  return registry.filter((other) => {
    if (other.engine !== trial.engine) return false
    let differences = 0
    for (const [key, levels] of Object.entries(axes)) {
      const left: unknown = Reflect.get(trial, key)
      const right: unknown = Reflect.get(other, key)
      if (left === right) continue
      const order: readonly unknown[] = levels
      const adjacent =
        key === 'filter' ||
        key === 'exit' ||
        (order.includes(left) && order.includes(right) && Math.abs(order.indexOf(left) - order.indexOf(right)) === 1)
      if (!adjacent || ++differences > 1) return false
    }
    return differences === 1
  })
}

export const comboTrials = (orb: Orb, noise: Noise): readonly Combo[] =>
  [0.25, 0.5, 0.75].map((orbWeight) => ({ id: `combo/${orbWeight}`, engine: 'combo', orb, noise, orbWeight }))

export const periods = {
  train: [firstDay, trainEnd],
  validation: ['2025-07-01', validationEnd],
  holdout: ['2026-04-01', lastDay],
  '2024H1': [firstDay, '2024-06-30'],
  '2024H2': ['2024-07-01', '2024-12-31'],
  '2025H1': ['2025-01-01', trainEnd],
  '2025H2': ['2025-07-01', '2025-12-31'],
  '2026H1': ['2026-01-01', '2026-06-30'],
  '2026H2': ['2026-07-01', lastDay],
} as const
