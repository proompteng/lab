import type { Bar, Tape } from './overnight-tugofwar-data'
import { anchors, borrowRate, capital, type Candidate, lookbacks } from './overnight-tugofwar-protocol'

interface Feature {
  depth: number
  persist: number[]
  spread: number[]
  above: Record<50 | 100 | 200, boolean>
  gap: number
  gapVol: number
  volumeReady: boolean
  trend: number
}

interface Asset {
  symbol: string
  sector: string
  bars: readonly (Bar | undefined)[]
  features: (Feature | undefined)[]
}

const dayMs = 86_400_000
const etfWarmup = 20

function features(bars: Asset['bars']): Asset['features'] {
  const on = [0]
  const id = [0]
  const squares = [0]
  const close = [0]
  const volume = [0]
  let depth = 0
  return bars.map((bar, i) => {
    const prior = bars[i - 1]
    depth = bar !== undefined ? depth + 1 : 0
    const gap = bar !== undefined && prior !== undefined ? Math.log(bar.open / prior.close) : 0
    on.push(on[i] + gap)
    id.push(id[i] + (bar !== undefined ? Math.log(bar.close / bar.open) : 0))
    squares.push(squares[i] + gap ** 2)
    close.push(close[i] + (bar?.close ?? 0))
    volume.push(volume[i] + (bar?.volume ?? 0))
    if (bar === undefined) return undefined
    const above = (n: number, j: number, price: number) => price > (close[j + 1] - close[j + 1 - n]) / n
    const slope = lookbacks.map((n) => (depth > n ? on[i + 1] - on[i + 1 - n] : Number.NaN))
    const gapMean = (on[i] - on[i - 20]) / 20
    const gapVariance = (squares[i] - squares[i - 20] - 20 * gapMean ** 2) / 19
    return {
      depth,
      persist: slope,
      spread: slope.map((x, j) => x - (id[i + 1] - id[i + 1 - lookbacks[j]])),
      above: {
        50: depth >= 50 && above(50, i, bar.close),
        100: depth >= 100 && above(100, i, bar.close),
        200: depth >= 200 && above(200, i, bar.close),
      },
      gap,
      gapVol: depth >= 22 && gapVariance > 0 ? Math.sqrt(gapVariance) : Number.NaN,
      volumeReady: depth >= 22 && prior !== undefined && prior.volume >= (1.2 * (volume[i - 1] - volume[i - 21])) / 20,
      trend: depth > 50 && prior !== undefined ? (above(50, i - 1, prior.close) ? 1 : -1) : 0,
    }
  })
}

export function prepare(tape: Tape) {
  const asset = (symbol: string, sector: string): Asset => {
    const bars = tape.bars.get(symbol)
    if (bars === undefined) throw new Error(`Missing series: ${symbol}`)
    return { symbol, sector, bars, features: features(bars) }
  }
  const etfs = tape.universe.etfs.map((symbol) => asset(symbol, symbol)).sort(bySymbol)
  const credit = etfs.find(({ symbol }) => symbol === 'HYG')
  if (credit === undefined) throw new Error('Missing HYG indicator')
  return {
    dates: tape.dates,
    days: tape.dates.map((date) => Date.parse(date) / dayMs),
    equities: [...tape.universe.equities].map(([symbol, sector]) => asset(symbol, sector)).sort(bySymbol),
    etfs,
    credit,
  }
}

const bySymbol = (a: Asset, b: Asset) => (a.symbol < b.symbol ? -1 : a.symbol === b.symbol ? 0 : 1)

type Market = ReturnType<typeof prepare>
type Selection = { asset: Asset; weight: number }[]
type Session = 'overnight' | 'intraday'
type Scored = { asset: Asset; score: number }
const rank = (a: Scored, b: Scored) => b.score - a.score || bySymbol(a.asset, b.asset)

export interface Day {
  pnl: number
  turnover: number
  sell: number
  borrow: number
  trades: number
  missedEntry: number
  lateExit: number
  announcedExit: number
  carry: number
  matchedOvernightPnl: number
  oppositePnl: number
  oppositeMissing: number
}

const newDay = (): Day => ({
  pnl: 0,
  turnover: 0,
  sell: 0,
  borrow: 0,
  trades: 0,
  missedEntry: 0,
  lateExit: 0,
  announcedExit: 0,
  carry: 0,
  matchedOvernightPnl: 0,
  oppositePnl: 0,
  oppositeMissing: 0,
})

interface Trade {
  asset: Asset
  start: number
  entryPrice: number
  shares: number
  due: number
}

function settle(trade: Trade, price: number, age: number, day: Day, index: number) {
  const { entryPrice, shares } = trade
  day.pnl += shares * (price - entryPrice)
  day.turnover += Math.abs(shares) * (entryPrice + price)
  day.sell += Math.abs(shares) * (shares < 0 ? entryPrice : price)
  if (shares < 0) day.borrow += (-shares * entryPrice * borrowRate * Math.max(1, age)) / 365
  day.trades++
  if (index > trade.due) day.lateExit++
}

export interface KnownExit {
  symbol: string
  announced: string
  lastClose: string
}

export function replay(
  market: Market,
  candidate: Candidate,
  omit?: string,
  knownExits: readonly KnownExit[] = [],
): Day[] {
  const segment: Session =
    candidate.family === 'gap' ? 'intraday' : candidate.family === 'etf' ? candidate.session : 'overnight'
  const marketAssets = (candidate.family === 'etf' ? market.etfs : market.equities).filter((a) => a.sector !== omit)
  const groups = new Map<string, Asset[]>()
  for (const asset of marketAssets) {
    const group = candidate.family !== 'etf' && candidate.scope === 'sector' ? asset.sector : 'all'
    const members = groups.get(group) ?? []
    members.push(asset)
    groups.set(group, members)
  }
  const exits = new Map<string, string>()
  for (const exit of knownExits) {
    if (exit.announced >= exit.lastClose || exits.has(exit.symbol))
      throw new Error(`Non-causal or duplicate exit: ${exit.symbol}`)
    exits.set(exit.symbol, exit.lastClose)
  }

  // Missing prints do not rewrite an executed entry. Keep exposure until the next matching print or an announced close.
  let positions: Trade[] = []
  let cached: Selection = []
  const output = market.dates.map(newDay)
  for (const [i, date] of market.dates.entries()) {
    const day = output[i]
    const enter = () => {
      if (i === 0 || (segment === 'overnight' && i === market.dates.length - 1)) return
      let targets: Selection
      if (candidate.family === 'persistence') {
        if (i % candidate.refresh === 0) cached = persistenceTargets(candidate, groups, i - 1)
        targets = cached.filter(({ asset }) => (asset.features[i - 1]?.depth ?? 0) > candidate.lookback)
      } else if (candidate.family === 'gap') {
        targets = gapTargets(candidate, groups, candidate.timing === 'same' ? i : i - 1)
      } else {
        targets = etfTargets(candidate, marketAssets, market.credit, i - 1)
      }
      const pending = new Set(positions.map(({ asset }) => asset.symbol))
      for (const { asset, weight } of targets) {
        if (pending.has(asset.symbol) || (exits.get(asset.symbol) ?? '9999') <= date) continue
        const sizingPrice = asset.bars[i - 1]?.close
        if (sizingPrice === undefined) continue
        const price = segment === 'overnight' ? asset.bars[i]?.close : asset.bars[i]?.open
        if (price === undefined) {
          day.missedEntry++
          continue
        }
        positions.push({
          asset,
          start: i,
          entryPrice: price,
          shares: (weight * capital) / sizingPrice,
          due: segment === 'overnight' ? i + 1 : i,
        })
      }
    }
    const exit = (at: 'open' | 'close') => {
      positions = positions.filter((trade) => {
        if (trade.due > i) return true
        const lastClose = exits.get(trade.asset.symbol)
        const announcedClose = lastClose !== undefined && lastClose <= date
        if (at === 'open' && (segment === 'intraday' || lastClose === date)) return true
        if (at === 'close' && segment === 'overnight' && !announcedClose) return true
        const bar = trade.asset.bars[i]
        const price = bar?.[at]
        if (price === undefined) return true
        settle(trade, price, market.days[i] - market.days[trade.start], day, i)
        if (at === 'close' && announcedClose) day.announcedExit++
        if (at === 'open' && candidate.family === 'persistence' && i === trade.due && bar !== undefined) {
          day.matchedOvernightPnl += trade.shares * (bar.open - trade.entryPrice)
          day.oppositePnl += trade.shares * (bar.close - bar.open)
        } else if (candidate.family === 'persistence') {
          day.oppositeMissing++
        }
        return false
      })
    }
    exit('open')
    if (segment === 'intraday') enter()
    exit('close')
    day.carry = positions.filter(({ due }) => due <= i).length
    if (segment === 'overnight') enter()
  }
  return output
}

function persistenceTargets(
  c: Extract<Candidate, { family: 'persistence' }>,
  groups: ReadonlyMap<string, readonly Asset[]>,
  index: number,
): Selection {
  const result: Selection = []
  const lookback = lookbacks.indexOf(c.lookback)
  for (const members of groups.values()) {
    const scores: Scored[] = []
    for (const asset of members) {
      const feature = asset.features[index]
      const score = feature?.[c.signal === 'spread' ? 'spread' : 'persist'][lookback]
      if (score !== undefined && Number.isFinite(score)) scores.push({ asset, score })
    }
    if (scores.length < 2) continue
    scores.sort(rank)
    const k = Math.min(Math.ceil(scores.length / 10), Math.floor(scores.length / 2))
    const weight = 1 / (groups.size * k * (c.side === 'neutral' ? 2 : 1))
    for (const { asset } of scores.slice(0, k)) result.push({ asset, weight })
    if (c.side === 'neutral') for (const { asset } of scores.slice(-k)) result.push({ asset, weight: -weight })
  }
  return result
}

function gapTargets(
  c: Extract<Candidate, { family: 'gap' }>,
  groups: ReadonlyMap<string, readonly Asset[]>,
  index: number,
): Selection {
  const result: Selection = []
  for (const members of groups.values()) {
    const eligible = members.filter((a) => Number.isFinite(a.features[index]?.gapVol))
    if (eligible.length < 2) continue
    const gaps = eligible.map((asset) => asset.features[index]?.gap ?? Number.NaN).sort((a, b) => a - b)
    const median = (gaps[Math.floor((gaps.length - 1) / 2)] + gaps[Math.floor(gaps.length / 2)]) / 2
    const longs: Scored[] = []
    const shorts: Scored[] = []
    for (const asset of eligible) {
      const signal = asset.features[index]
      if (signal === undefined) continue
      const z = (signal.gap - median) / signal.gapVol
      if (Math.abs(z) < c.threshold) continue
      if (c.signal === 'continuation' && (!signal.volumeReady || Math.sign(z) !== signal.trend)) continue
      const score = c.signal === 'fade' ? -z : z
      const tail = score > 0 ? longs : shorts
      tail.push({ asset, score })
    }
    const k = Math.min(longs.length, shorts.length, Math.ceil(eligible.length / 10))
    if (k === 0) continue
    const weight = 0.5 / (groups.size * k)
    for (const { asset } of longs.sort(rank).slice(0, k)) result.push({ asset, weight })
    for (const { asset } of shorts.sort(rank).slice(-k)) result.push({ asset, weight: -weight })
  }
  return result
}

function etfTargets(
  c: Extract<Candidate, { family: 'etf' }>,
  assets: Asset[],
  credit: Asset,
  index: number,
): Selection {
  if (c.filter === 'credit' && credit.features[index]?.above[100] !== true) return []
  const pool = assets.filter((a) => {
    if (c.universe === 'anchors' && !anchors.some((symbol) => symbol === a.symbol)) return false
    return (a.features[index]?.depth ?? 0) >= etfWarmup
  })
  const filter = c.filter
  return pool
    .filter((a) => typeof filter !== 'number' || a.features[index]?.above[filter] === true)
    .map((asset) => ({ asset, weight: 1 / pool.length }))
}

export function blend(legs: readonly { weight: number; path: readonly Day[] }[]): Day[] {
  return (legs[0]?.path ?? []).map((_, i) => {
    const day = newDay()
    for (const { weight, path } of legs) {
      const leg = path[i]
      day.pnl += leg.pnl * weight
      day.turnover += leg.turnover * weight
      day.sell += leg.sell * weight
      day.borrow += leg.borrow * weight
      day.trades += leg.trades
      day.missedEntry += leg.missedEntry
      day.lateExit += leg.lateExit
      day.announcedExit += leg.announcedExit
      day.carry += leg.carry
    }
    return day
  })
}
