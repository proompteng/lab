// Locked Wave 3C signals and paper weighting (proompteng/lab@6662581cd, PR #16367).
import { mean } from './midday-research-statistics'

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

const grossCap = 1.8
const annualDays = 252

interface Bar {
  readonly open: number
  readonly close: number
}
interface Session {
  readonly date: string
  readonly bars: readonly (Bar | undefined)[]
}
export type Weights = readonly number[]
const flat = () => etfs.map(() => 0)
const gross = (weights: Weights) => weights.reduce((sum, weight) => sum + Math.abs(weight), 0)
const cap = (weights: Weights) => {
  const exposure = gross(weights)
  return exposure <= grossCap ? weights : weights.map((weight) => (weight * grossCap) / exposure)
}
const spy = indexOf('SPY')
const tlt = indexOf('TLT')
const hyg = indexOf('HYG')
const trendUniverse = [
  'SPY',
  'QQQ',
  'EFA',
  'EEM',
  'TLT',
  'IEF',
  'HYG',
  'LQD',
  'GLD',
  'SLV',
  'DBC',
  'USO',
  'VNQ',
] as const
const tomUniverse = ['SPY', 'QQQ'] as const
const pullbackUniverse = ['SPY', 'QQQ', 'IWM', 'SMH', 'XLK', 'XLF', 'XLV', 'XLI', 'XLY', 'XLE', 'GLD'] as const
const riskOn = ['XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB', 'SMH', 'QQQ'] as const
const riskOff = ['GLD', 'TLT', 'SHY'] as const

const trailing = (values: readonly number[], end: number, count: number) =>
  end + 1 >= count ? values.slice(end + 1 - count, end + 1) : []

const sampleVol = (values: readonly number[]) => {
  const center = mean(values)
  return Math.sqrt((values.reduce((sum, x) => sum + (x - center) ** 2, 0) / (values.length - 1)) * annualDays)
}

function monthOffsets(dates: readonly string[]) {
  const offsets: { fromStart: number; toEnd: number; monthBase: number }[] = []
  for (let start = 0; start < dates.length; ) {
    let end = start
    while (dates[end + 1]?.slice(0, 7) === dates[start].slice(0, 7)) end++
    for (let i = start; i <= end; i++) offsets.push({ fromStart: i - start + 1, toEnd: i - end, monthBase: start - 1 })
    start = end + 1
  }
  return offsets
}

// Wilder smoothing starts after two valid changes and resets across missing history.
function rsi2(changes: readonly number[]) {
  let count = 0
  let gains = 0
  let losses = 0
  return changes.map((change) => {
    if (!Number.isFinite(change)) {
      count = gains = losses = 0
      return NaN
    }
    const gain = Math.max(0, change)
    const loss = Math.max(0, -change)
    count++
    gains = count < 2 ? gain : (gains + gain) / 2
    losses = count < 2 ? loss : (losses + loss) / 2
    return count < 2 ? NaN : gains + losses === 0 ? 50 : (100 * gains) / (gains + losses)
  })
}

function makeFeatures(sessions: readonly Session[]) {
  // These are scheduled sessions only, not synthetic prices at the end of the tape.
  const dates = monthOffsets([...sessions.map(({ date }) => date), '2026-11-27', '2026-11-30'])
  const closes = etfs.map((_, id) => sessions.map((session) => session.bars[id]?.close ?? NaN))
  const returns = closes.map((series) => series.map((close, i) => close / series[i - 1] - 1))
  const rsis = closes.map((series) => rsi2(series.map((close, i) => close - series[i - 1])))
  return sessions.map((_, i) => {
    const { fromStart, toEnd, monthBase } = dates[i]
    const assets = closes.map((series, id) => {
      const close = series[i]
      const daily = trailing(returns[id], i, 20)
      return {
        close,
        daily,
        vol: daily.length === 20 ? sampleVol(daily) : NaN,
        sma50: mean(trailing(series, i, 50)),
        sma100: mean(trailing(series, i, 100)),
        momentum: close / series[i - 120] - 1,
        rsi: rsis[id][i],
        mtd: close / series[monthBase] - 1,
      }
    })
    return { fromStart, toEnd, assets }
  })
}
type Assets = ReturnType<typeof makeFeatures>[number]['assets']

function volSized(assets: Assets, pool: readonly Etf[], target: number, direction: (i: number) => number) {
  const weights = flat()
  for (const symbol of pool) {
    const i = indexOf(symbol)
    if (assets[i].vol > 0) weights[i] = direction(i) / assets[i].vol
  }
  const paper = Array.from({ length: 20 }, (_, day) =>
    weights.reduce((sum, weight, symbol) => (weight === 0 ? sum : sum + weight * assets[symbol].daily[day]), 0),
  )
  const vol = sampleVol(paper)
  return vol > 0 ? cap(weights.map((weight) => (weight * target) / vol)) : flat()
}

export function etfBooks(sessions: readonly Session[]) {
  const books = {
    trend: [] as Weights[],
    pension: [] as Weights[],
    tom: [] as Weights[],
    pullback: [] as Weights[],
    rotation: [] as Weights[],
  }
  let trend: Weights = flat()
  let rotation: Weights = flat()
  let pension: Weights = flat()
  let tom: Weights = flat()
  const pullback = flat()
  const entries = new Map<number, number>()
  for (const [i, { fromStart, toEnd, assets }] of makeFeatures(sessions).entries()) {
    if (i % 5 === 0) {
      const sized = volSized(assets, trendUniverse, 0.1, (id) => {
        const score = assets[id].momentum
        return score > 0 ? 1 : score < 0 ? -1 : 0
      })
      const prior = trend
      trend = cap(
        sized.map((weight, id) =>
          Math.sign(weight) === Math.sign(prior[id]) && Math.abs(weight - prior[id]) < 0.05 ? prior[id] : weight,
        ),
      )
      const credit = assets[hyg]
      const pool = credit.sma50 > 0 ? (credit.close > credit.sma50 ? riskOn : riskOff) : []
      const ranked = pool
        .map(indexOf)
        .filter((id) => assets[id].vol > 0 && assets[id].momentum > 0)
        .sort((a, b) => assets[b].momentum / assets[b].vol - assets[a].momentum / assets[a].vol || a - b)
      const next = flat()
      for (const id of ranked.slice(0, 3)) next[id] = 1 / 3
      rotation = next
    }
    if (toEnd === 0) pension = flat()
    if (toEnd === -5) {
      const spread = assets[spy].mtd - assets[tlt].mtd
      if (Math.abs(spread) >= 0.02) {
        const next = flat()
        next[spread > 0 ? tlt : spy] = 1
        pension = next
      }
    }
    if (fromStart === 4) tom = flat()
    if (toEnd === -3) tom = volSized(assets, tomUniverse, 0.15, () => 1)

    const exited = new Set<number>()
    for (const [id, entered] of entries) {
      if (i - entered >= 7 || assets[id].rsi > 70) {
        entries.delete(id)
        exited.add(id)
        pullback[id] = 0
      }
    }
    const eligible = pullbackUniverse
      .map(indexOf)
      .filter((id) => {
        const a = assets[id]
        return !entries.has(id) && !exited.has(id) && a.close > a.sma100 && a.vol > 0 && a.rsi < 15
      })
      .sort((a, b) => assets[a].rsi - assets[b].rsi || a - b)
    for (const id of eligible.slice(0, 4 - entries.size)) {
      entries.set(id, i)
      pullback[id] = Math.min(0.25, 0.05 / assets[id].vol)
    }
    books.trend.push(trend)
    books.rotation.push(rotation)
    books.pension.push(pension)
    books.tom.push(tom)
    books.pullback.push([...pullback])
  }
  const s1 = blend([books.trend, books.pension, books.tom, books.pullback, books.rotation], sessions)
  // Fixed one-third-risk core, not a turnover- or P&L-optimized allocation.
  const s2 = blend([books.trend, books.rotation], sessions).map((book) => book.map((weight) => weight / 3))
  return { s1, s2 }
}

// Paper return for the Wave 3C lagged allocator only. Account execution/carry live in the shared ledger.
function paperReturns(sessions: readonly Session[], book: readonly Weights[]) {
  let marked: Weights = flat()
  let previous: Weights = flat()
  return sessions.map((session, i) => {
    const desired = book[i - 1] ?? flat()
    const held = cap(marked.map((value, id) => (Math.abs(desired[id] - previous[id]) > 1e-12 ? desired[id] : value)))
    previous = desired
    const next = sessions[i + 1]
    if (next === undefined) return 0
    const days = (Date.parse(next.date) - Date.parse(session.date)) / 86_400_000
    let net = 0
    marked = held.map((value, id) => {
      const delta = value - marked[id]
      net -= Math.abs(delta) * 0.0005 + Math.max(0, -delta) * 0.000021 + (Math.max(0, -value) * 0.015 * days) / 365
      if (value === 0) return 0
      const open = session.bars[id]?.open
      const nextOpen = next.bars[id]?.open
      if (open === undefined || nextOpen === undefined)
        throw new Error(`Missing Wave 3C paper mark: ${etfs[id]} ${session.date}`)
      const change = value * (nextOpen / open - 1)
      net += change
      return value + change
    })
    return net
  })
}
/** Inverse trailing paper-sleeve volatility, updated every five sessions, with no same-open observation. */
const blend = (books: readonly (readonly Weights[])[], sessions: readonly Session[]): Weights[] => {
  if (books.length === 0) return []
  const papers = books.map((book) => paperReturns(sessions, book))
  let budgets = papers.map(() => 1 / papers.length)
  return sessions.map((_, i) => {
    if (i >= 60 && i % 5 === 0) {
      const strength = papers.map((series) => 1 / Math.max(0.02, sampleVol(series.slice(i - 60, i))))
      const sum = strength.reduce((total, value) => total + value, 0)
      budgets = strength.map((value) => value / sum)
    }
    return cap(etfs.map((_, symbol) => books.reduce((sum, book, j) => sum + budgets[j] * book[i][symbol], 0)))
  })
}
