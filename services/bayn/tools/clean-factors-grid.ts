export const books = ['long', 'regime-hedged', 'dollar-neutral', 'sector-neutral', 'beta-hedged'] as const
type Book = (typeof books)[number]
type Factor = 'high' | 'quality' | 'momentum' | 'bab'
export type Equity = {
  id: string
  family: 'high' | 'quality' | 'managed'
  factor: Factor
  book: Book
  k: number
  cycle: number
  sma: number
  targetVol: number
}
export type Overlay = { id: string; horizon: number; cycle: number }
export type Candidate = {
  id: string
  family: Equity['family'] | 'overlay' | 'combined'
  equity?: Equity
  overlay?: Overlay
  overlayShare: number
}

const equity = (factor: Factor, book: Book, k: number, cycle = 21, sma = 0, targetVol = 0): Candidate => {
  const id = [factor, book, k, cycle, ...(sma > 0 ? [sma, targetVol] : [])].join('-')
  const family = factor === 'bab' || factor === 'momentum' ? 'managed' : factor
  return { id, family, equity: { id, factor, family, book, k, cycle, sma, targetVol }, overlayShare: 0 }
}

const sizes = [10, 15, 20]
export const equityGrid = [
  ...sizes.flatMap((k) =>
    (['long', 'regime-hedged', 'dollar-neutral', 'sector-neutral'] as const).map((book) => equity('high', book, k)),
  ),
  ...sizes.flatMap((k) =>
    (['long', 'beta-hedged', 'sector-neutral'] as const).map((book) => equity('quality', book, k)),
  ),
  ...(['momentum', 'bab'] as const).flatMap((factor) =>
    sizes.flatMap((k) =>
      [10, 21].flatMap((cycle) =>
        [50, 100].flatMap((sma) => [0.08, 0.12].map((vol) => equity(factor, 'dollar-neutral', k, cycle, sma, vol))),
      ),
    ),
  ),
]
export const overlayGrid: (Candidate & { overlay: Overlay })[] = [126, 252].flatMap((horizon) =>
  [10, 21].map((cycle) => {
    const id = `etf-${horizon}-${cycle}`
    return { id, family: 'overlay', overlay: { id, horizon, cycle }, overlayShare: 1 }
  }),
)
export const combinedGrid = (selected: Equity): Candidate[] =>
  overlayGrid.flatMap(({ overlay }) =>
    [0.25, 0.5, 0.75].map((overlayShare) => ({
      id: `mix-${selected.id}-${overlay.id}-${overlayShare}`,
      family: 'combined',
      equity: selected,
      overlay,
      overlayShare,
    })),
  )

export function neighbors(candidate: Candidate, grid: readonly Candidate[]) {
  return grid.filter((other) => {
    if (other.id === candidate.id || other.family !== candidate.family) return false
    const a = candidate.equity
    const b = other.equity
    let changes = 0
    if (a !== undefined && b !== undefined) {
      if (a.factor !== b.factor || a.book !== b.book) return false
      changes +=
        Number(a.k !== b.k) +
        Number(a.cycle !== b.cycle) +
        Number(a.sma !== b.sma) +
        Number(a.targetVol !== b.targetVol)
    }
    if (candidate.overlay !== undefined && other.overlay !== undefined) {
      changes +=
        Number(candidate.overlay.horizon !== other.overlay.horizon) +
        Number(candidate.overlay.cycle !== other.overlay.cycle)
      if (Math.abs(candidate.overlayShare - other.overlayShare) > 0.25) return false
      changes += Number(candidate.overlayShare !== other.overlayShare)
    }
    return changes === 1
  })
}

export const costs = [2, 5, 10, 20] as const
export type Cost = (typeof costs)[number]
export const capital = 100_000
export const priorTrials = 360
