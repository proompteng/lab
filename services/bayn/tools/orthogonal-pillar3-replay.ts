import { mean, sum } from './midday-research-statistics'
import { type Session, assets as frozenAssets, universe as frozenUniverse } from './vol-regime-carry-data'
import { shouldTrade } from './vol-regime-carry-replay'

export const universe = [...frozenUniverse, 'TIP'] as const
export const assets = { ...frozenAssets, TIP: frozenUniverse.length }
export type Symbol = (typeof universe)[number]

const curve = {
  slope: [
    ['TLT', 'SHY'],
    ['TLT', 'IEF'],
  ],
  breakeven: [['TIP', 'IEF']],
  credit: [['HYG', 'LQD']],
  all: [
    ['TLT', 'SHY'],
    ['TLT', 'IEF'],
    ['TIP', 'IEF'],
    ['HYG', 'LQD'],
  ],
} as const
export const commodities = ['GLD', 'SLV', 'DBC', 'USO', 'UUP'] as const
export const sectors = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC'] as const
const cadence = [21, 42] as const
const horizons = [63, 126, 252] as const
const volFloor = 0.0025
const sellFee = 0.21 / 10_000

type Schedule = { id: string; cadence: (typeof cadence)[number] }
export type Trial = Schedule &
  (
    | { family: 'A'; proxy: keyof typeof curve; horizon: 63 | 126 }
    | { family: 'B'; mode: 'long' | 'long-short' }
    | { family: 'C'; signal: 63 | 126 | -21; names: 2 | 3 }
  )

export const grid: readonly Trial[] = [
  ...(['slope', 'breakeven', 'credit', 'all'] as const).flatMap((proxy) =>
    ([63, 126] as const).flatMap((horizon) =>
      cadence.map((days) => ({
        id: `A/${proxy}/${horizon}/${days}`,
        family: 'A' as const,
        proxy,
        horizon,
        cadence: days,
      })),
    ),
  ),
  ...(['long', 'long-short'] as const).flatMap((mode) =>
    cadence.map((days) => ({ id: `B/${mode}/${days}`, family: 'B' as const, mode, cadence: days })),
  ),
  ...([63, 126, -21] as const).flatMap((signal) =>
    ([2, 3] as const).flatMap((names) =>
      cadence.map((days) => ({
        id: `C/${signal}/${names}/${days}`,
        family: 'C' as const,
        signal,
        names,
        cadence: days,
      })),
    ),
  ),
]

const empty = () => universe.map(() => 0)
const idle = () => universe.map((symbol) => Number(symbol === 'SHY'))

export const deviation = (values: readonly number[]) => {
  const center = mean(values)
  return Math.sqrt(sum(values.map((value) => (value - center) ** 2)) / (values.length - 1))
}

export const beta = (returns: readonly number[], market: readonly number[]) => {
  const x = mean(market)
  const y = mean(returns)
  const variance = sum(market.map((value) => (value - x) ** 2))
  return variance > 0 ? sum(market.map((value, i) => (value - x) * (returns[i] - y))) / variance : null
}

type Ranked = { symbol: Symbol; score: number; beta: number }
export const sectorTarget = (ranked: readonly Ranked[], names: number) => {
  if (ranked.length < 2 * names) return idle()
  const sorted = ranked.toSorted((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol, 'en'))
  const sides = [sorted.slice(0, names), sorted.slice(-names)]
  const extremes = sides.map((side) => side.toSorted((a, b) => a.beta - b.beta))
  const lo = Math.max(...extremes.map((side) => side[0].beta))
  const hi = Math.min(...extremes.map((side) => side[side.length - 1].beta))
  const common = (lo + hi) / 2
  // Matching at a nonconstant side's endpoint would assign zero weight to other selected names.
  if (
    lo > hi ||
    extremes.some((side) => {
      const low = side[0].beta
      const high = side[side.length - 1].beta
      return low !== high && (common <= low || common >= high)
    })
  )
    return idle()

  const target = idle()
  sides.forEach((side, i) => {
    const center = mean(side.map((name) => name.beta))
    const edge = extremes[i][common < center ? 0 : names - 1]
    const mix = Math.abs(common - center) < 1e-12 ? 0 : (common - center) / (edge.beta - center)
    const budget = i === 0 ? 0.5 : -0.5
    for (const name of side) target[assets[name.symbol]] = (budget * (1 - mix)) / names
    target[assets[edge.symbol]] += budget * mix
  })
  return target
}

export const model = (sessions: readonly Session[]) => {
  const daily = universe.map((_, j) =>
    sessions.map(({ bars }, day) => {
      const close = bars[j]?.close
      const previous = sessions[day - 1]?.bars[j]?.close
      return close === undefined || previous === undefined ? undefined : Math.log(close / previous)
    }),
  )
  const history = (symbol: Symbol, day: number, count: number) => {
    if (day < count) return undefined
    const values = daily[assets[symbol]].slice(day - count + 1, day + 1)
    return values.every((value) => value !== undefined) ? values : undefined
  }
  const targetAt = (trial: Trial, day: number) => {
    if (trial.family === 'A') {
      const votes = empty()
      for (const [a, b] of curve[trial.proxy]) {
        const x = history(a, day, trial.horizon)
        const y = history(b, day, trial.horizon)
        if (x === undefined || y === undefined) return idle()
        const relative = sum(x) - sum(y)
        if (relative === 0) continue
        const winner = relative > 0 ? a : b
        const recent = relative > 0 ? x : y
        votes[assets[winner]] += 1 / Math.max(volFloor, deviation(recent.slice(-20)))
      }
      const total = sum(votes)
      if (total === 0) return idle()
      const target = votes.map((vote) => (0.8 * vote) / total)
      target[assets.SHY] += 0.2
      return target
    }
    if (trial.family === 'B') {
      const scores = []
      for (const symbol of commodities) {
        const longest = history(symbol, day, 252)
        if (longest === undefined) return idle()
        const vol = Math.max(volFloor, deviation(longest.slice(-20)))
        const strength = Math.tanh(
          mean(horizons.map((length) => sum(longest.slice(-length)) / (vol * Math.sqrt(length)))),
        )
        scores.push({ symbol, inverseVol: 1 / vol, strength: trial.mode === 'long' ? Math.max(0, strength) : strength })
      }
      const total = sum(scores.map(({ inverseVol }) => inverseVol))
      const target = empty()
      for (const { symbol, inverseVol, strength } of scores) target[assets[symbol]] = (inverseVol * strength) / total
      target[assets.SHY] = 1 - sum(target.map(Math.abs))
      return target
    }
    const market = history('SPY', day, 126)
    if (market === undefined) return idle()
    const ranked = sectors.flatMap((symbol) => {
      const history126 = history(symbol, day, 126)
      if (history126 === undefined) return []
      const estimatedBeta = beta(history126, market)
      if (estimatedBeta === null) return []
      const count = Math.abs(trial.signal)
      const signal = history126.slice(-count)
      return [
        {
          symbol,
          beta: estimatedBeta,
          score: (Math.sign(trial.signal) * sum(signal)) / (Math.sqrt(count) * Math.max(volFloor, deviation(signal))),
        },
      ]
    })
    return sectorTarget(ranked, trial.names)
  }
  return (trial: Trial) =>
    sessions.map((_, day) => ((day + 1) % trial.cadence === 0 ? targetAt(trial, day) : undefined))
}

export type Day = { net: number; turnover: number; borrow: number }

const mark = (session: Session, j: number, field: 'open' | 'close') => {
  const price = session.bars[j]?.[field]
  if (price === undefined) throw new Error(`Missing ${field} mark for ${universe[j]} on ${session.date}`)
  return price
}
const marked = (shares: readonly number[], session: Session, field: 'open' | 'close') =>
  shares.map((quantity, j) => (quantity === 0 ? 0 : quantity * mark(session, j, field)))

export const benchmarks = (sessions: readonly Session[], symbol: 'SHY' | 'SPY') =>
  sessions.map((session, i) => {
    const j = assets[symbol]
    const previous = sessions[i - 1]
    return (
      mark(session, j, 'close') / (previous === undefined ? mark(session, j, 'open') : mark(previous, j, 'close')) - 1
    )
  })

const shortNotional = (notionals: readonly number[]) => sum(notionals.map((value) => Math.max(0, -value)))

export const replay = (
  sessions: readonly Session[],
  targets: readonly (number[] | undefined)[],
  bp: number,
  annualBorrow: number,
): Day[] => {
  let cash = 1
  let equity = 1
  let shares = empty()
  let close = empty()
  return sessions.map((session, i) => {
    const earlier = sessions[i - 1]
    const gap = earlier === undefined ? 0 : (Date.parse(session.date) - Date.parse(earlier.date)) / 86_400_000 - 1
    const carriedBorrow = (shortNotional(close) * gap * annualBorrow) / 365
    const review = targets[i - 1]
    const target =
      i === 0
        ? idle()
        : review !== undefined &&
            shouldTrade(
              close.map((value) => value / equity),
              review,
            )
          ? review
          : undefined
    let open = marked(shares, session, 'open')
    cash -= carriedBorrow
    const nav = cash + sum(open)
    if (!(nav > 0)) throw new Error(`Insolvent opening NAV on ${session.date}`)
    let turnover = 0
    if (target !== undefined) {
      let post = nav
      const cost = bp / 10_000
      const changes = (value: number) => target.map((weight, j) => value * weight - open[j])
      // Fixed point: transaction charges are paid out of the same NAV used to set notional.
      for (let iteration = 0; iteration < 8; iteration++) {
        const delta = changes(post)
        post = nav - cost * sum(delta.map(Math.abs)) - sellFee * shortNotional(delta)
      }
      turnover = sum(changes(post).map(Math.abs)) / (2 * nav)
      open = target.map((weight) => weight * post)
      cash = post - sum(open)
      shares = open.map((value, j) => (value === 0 ? 0 : value / mark(session, j, 'open')))
    }
    const sessionBorrow = (shortNotional(open) * annualBorrow) / 365
    cash -= sessionBorrow
    close = marked(shares, session, 'close')
    const next = cash + sum(close)
    if (!(next > 0)) throw new Error(`Insolvent closing NAV on ${session.date}`)
    const result = { net: next / equity - 1, turnover, borrow: (carriedBorrow + sessionBorrow) / equity }
    equity = next
    return result
  })
}
