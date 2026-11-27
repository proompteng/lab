export const capital = 100_000
export const costs = [2, 5, 10, 20] as const
export const sellFeeBp = 0.21
export const borrowRate = 0.015
export const anchors = ['SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'HYG', 'EFA', 'EEM'] as const
export const lookbacks = [20, 60, 120] as const

type Lookback = (typeof lookbacks)[number]
type Scope = 'universe' | 'sector'
type Trend = 50 | 100 | 200
type EtfFilter = 'none' | Trend | 'credit'

interface Persistence {
  id: string
  family: 'persistence'
  signal: 'overnight' | 'spread'
  lookback: Lookback
  scope: Scope
  side: 'neutral' | 'long'
  refresh: 1 | 5 | 10
}

interface Gap {
  id: string
  family: 'gap'
  signal: 'fade' | 'continuation'
  scope: Scope
  threshold: 1.5 | 2
  timing: 'prior' | 'same'
}

interface Etf {
  id: string
  family: 'etf'
  universe: 'all' | 'anchors'
  session: 'overnight' | 'intraday'
  filter: EtfFilter
}

export type Candidate = Persistence | Gap | Etf
export const executable = (c: Candidate) => c.family !== 'gap' || c.timing === 'prior'

export function grid(): Candidate[] {
  const out: Candidate[] = []
  const scopes = ['universe', 'sector'] as const
  for (const lookback of lookbacks) {
    for (const signal of ['overnight', 'spread'] as const) {
      for (const scope of scopes) {
        out.push({
          id: `lps-${signal}-${lookback}-${scope}-neutral-1`,
          family: 'persistence',
          signal,
          lookback,
          scope,
          side: 'neutral',
          refresh: 1,
        })
      }
    }
    out.push({
      id: `lps-overnight-${lookback}-universe-long-1`,
      family: 'persistence',
      signal: 'overnight',
      lookback,
      scope: 'universe',
      side: 'long',
      refresh: 1,
    })
  }
  for (const refresh of [5, 10] as const) {
    out.push({
      id: `lps-overnight-60-universe-long-${refresh}`,
      family: 'persistence',
      signal: 'overnight',
      lookback: 60,
      scope: 'universe',
      side: 'long',
      refresh,
    })
  }
  out.push({
    id: 'lps-spread-60-sector-long-1',
    family: 'persistence',
    signal: 'spread',
    lookback: 60,
    scope: 'sector',
    side: 'long',
    refresh: 1,
  })
  for (const signal of ['fade', 'continuation'] as const) {
    for (const scope of scopes) {
      for (const threshold of [1.5, 2] as const) {
        for (const timing of ['prior', 'same'] as const) {
          out.push({
            id: `gap-${signal}-${scope}-${threshold}-${timing}`,
            family: 'gap',
            signal,
            scope,
            threshold,
            timing,
          })
        }
      }
    }
  }
  for (const universe of ['all', 'anchors'] as const) {
    for (const filter of (universe === 'all'
      ? ['none', 50, 100, 200, 'credit']
      : ['none', 100, 'credit']) as EtfFilter[]) {
      out.push({ id: `etf-${universe}-overnight-${filter}`, family: 'etf', universe, session: 'overnight', filter })
    }
    out.push({ id: `etf-${universe}-intraday-none`, family: 'etf', universe, session: 'intraday', filter: 'none' })
  }
  return out
}

export const ensembleId = 'ensemble-train-risk-parity'

export function neighbors(a: Candidate, b: Candidate): boolean {
  if (a.family !== b.family) return false
  const entries = Object.entries(a).filter(([key]) => key !== 'id')
  const changes = entries.filter(([key, value]) => Object.entries(b).find(([k]) => k === key)?.[1] !== value)
  return changes.length === 1 && changes[0][0] !== 'timing'
}
