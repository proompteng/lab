import { barIndex, type Coin, type Market } from './research-crypto-trend-data'
import {
  compression,
  dayMs,
  fees,
  momentumBand,
  roster,
  symbols,
  trend,
  type Trial,
} from './research-crypto-trend-protocol'

export type Day = {
  net: number
  min: number
  max: number
  drawdown: number
  turnover: number
  feeDrag: number
  heldBars: number
  staleBars: number
  unsettled: number
}
type Book = {
  units: Float64Array
  delta: Float64Array
  bought: Uint8Array
  cash: number
  priorClose: number
  day: Day
  history: Day[]
  fee: number
}
const startDay = (): Day => ({
  net: 0,
  min: 1,
  max: 1,
  drawdown: 0,
  turnover: 0,
  feeDrag: 0,
  heldBars: 0,
  staleBars: 0,
  unsettled: 0,
})
const newBook = (bp: number, n: number): Book => ({
  units: new Float64Array(n),
  delta: new Float64Array(n),
  bought: new Uint8Array(n),
  cash: 1,
  priorClose: 1,
  day: startDay(),
  history: [],
  fee: bp / 20_000,
})
const nav = (book: Book, marks: Float64Array) => {
  let value = book.cash
  for (let j = 0; j < marks.length; j++) value += marks[j] * book.units[j]
  return value
}
const recordMark = (book: Book, mark: number) => {
  const { day } = book
  const relative = mark / book.priorClose
  day.min = Math.min(day.min, relative)
  day.max = Math.max(day.max, relative)
  day.drawdown = Math.max(day.drawdown, 1 - relative / day.max)
  day.net = relative - 1
}

const rebalance = (
  book: Book,
  marks: Float64Array,
  observed: Uint8Array,
  target: Float64Array,
  equity: number,
  canResize: boolean,
  band: 'absolute' | 'relative',
  closing: boolean,
  benchmark: boolean,
) => {
  let buy = 0
  let sold = 0
  book.delta.fill(0)
  for (let j = 0; j < marks.length; j++) {
    if (observed[j] === 0) continue
    const current = marks[j] * book.units[j]
    let desired = 0
    if (!closing) {
      if (benchmark && book.bought[j] === 1) continue
      desired = benchmark ? target[j] / (1 + book.fee) : equity * target[j]
    }
    const diff = desired - current
    if (
      desired > 0 &&
      current > 0 &&
      (!canResize || Math.abs(diff) < (band === 'absolute' ? momentumBand * equity : trend.relativeBand * desired))
    )
      continue
    if (diff < 0) {
      book.units[j] = desired / marks[j]
      sold -= diff
    } else if (diff > 0) {
      buy += diff
      book.delta[j] = diff
    }
  }
  book.cash += sold * (1 - book.fee)
  const scale = buy === 0 ? 0 : Math.min(1, book.cash / (buy * (1 + book.fee)))
  for (let j = 0; j < marks.length; j++) {
    if (book.delta[j] === 0 || scale === 0) continue
    book.units[j] += (book.delta[j] * scale) / marks[j]
    book.bought[j] = 1
  }
  book.cash = Math.max(0, book.cash - buy * scale * (1 + book.fee))
  const turnover = (sold + buy * scale) / equity
  book.day.turnover += turnover
  book.day.feeDrag += turnover * book.fee
}

type Indicators = {
  bar: Coin
  contiguous: Uint32Array
  vol: (n: number) => Float64Array
  sma: (n: number) => Float64Array
  ema: (n: number) => Float64Array
  high: (n: number) => Float64Array
  low: (n: number) => Float64Array
  atr: (n: number) => Float64Array
}

const prepareCoin = (bar: Coin, barsPerDay: number): Indicators => {
  const n = bar.close.length
  const contiguous = new Uint32Array(n)
  const log = new Float64Array(n + 1)
  const square = new Float64Array(n + 1)
  const close = new Float64Array(n + 1)
  const tr = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const previous = i > 0 ? bar.close[i - 1] : 0
    const valid = bar.close[i] > 0
    contiguous[i] = valid ? (contiguous[i - 1] ?? 0) + 1 : 0
    const r = valid && previous > 0 ? Math.log(bar.close[i] / previous) : 0
    log[i + 1] = log[i] + r
    square[i + 1] = square[i] + r * r
    close[i + 1] = close[i] + bar.close[i]
    tr[i + 1] =
      tr[i] +
      (valid && previous > 0
        ? Math.max(bar.high[i] - bar.low[i], Math.abs(bar.high[i] - previous), Math.abs(bar.low[i] - previous))
        : 0)
  }
  const fromWindow = (compute: (i: number, length: number) => number) => {
    const cache = new Map<number, Float64Array>()
    return (length: number) => {
      const exists = cache.get(length)
      if (exists !== undefined) return exists
      const output = new Float64Array(n)
      for (let i = length - 1; i < n; i++) output[i] = compute(i, length)
      cache.set(length, output)
      return output
    }
  }
  const priorExtreme = (values: Float64Array, combine: typeof Math.max) =>
    fromWindow((i, length) => {
      if (i === 0 || contiguous[i - 1] < length) return 0
      let extreme = values[i - 1]
      for (let at = i - 2; at >= i - length; at--) extreme = combine(extreme, values[at])
      return extreme
    })
  const sma = fromWindow((i, length) => {
    // Cache and mask independently: seed with the first full consecutive window's SMA.
    if (contiguous[i] < length) return 0
    return (close[i + 1] - close[i + 1 - length]) / length
  })
  const expCache = new Map<number, Float64Array>()
  return {
    bar,
    contiguous,
    vol: fromWindow((i, length) => {
      if (contiguous[i] <= length) return 0
      const sum = log[i + 1] - log[i + 1 - length]
      const sq = square[i + 1] - square[i + 1 - length]
      return Math.sqrt(Math.max(0, (sq - (sum * sum) / length) / (length - 1)) * 365 * barsPerDay)
    }),
    sma,
    ema: (length) => {
      const existing = expCache.get(length)
      if (existing !== undefined) return existing
      const values = new Float64Array(n)
      const smooth = 2 / (length + 1)
      const seed = sma(length)
      for (let i = length - 1; i < n; i++) {
        if (contiguous[i] === length) values[i] = seed[i]
        else if (contiguous[i] > length) values[i] = values[i - 1] + smooth * (bar.close[i] - values[i - 1])
      }
      expCache.set(length, values)
      return values
    },
    high: priorExtreme(bar.high, Math.max),
    low: priorExtreme(bar.low, Math.min),
    atr: fromWindow((i, length) => (contiguous[i] > length ? (tr[i + 1] - tr[i + 1 - length]) / length : 0)),
  }
}

export const prepareMarket = (market: Market) => ({
  market,
  coins: new Map([...market.coins].map(([name, coin]) => [name, prepareCoin(coin, market.barsPerDay)])),
})
type Prepared = ReturnType<typeof prepareMarket>
const cadence = (market: Market, execution: number, days: number) =>
  (market.start / dayMs + execution / market.barsPerDay - 4) % days === 0 // UTC Monday epoch (1970-01-05).

const signal = (market: Market, coins: readonly Indicators[], trial: Trial) => {
  const { rule } = trial
  const { barsPerDay } = market
  const toBars = (hours: number) => Math.ceil((hours * barsPerDay) / 24)
  const target = new Float64Array(coins.length)
  const vol = coins.map((coin) => coin.vol(trend.volDays * barsPerDay))
  if (rule.kind === 'momentum') {
    const length = rule.days * barsPerDay
    const rankVol = coins.map((coin) => coin.vol(length))
    const sma = coins.map((coin) => coin.sma(20 * barsPerDay))
    const rank: { j: number; score: number; eligible: boolean }[] = []
    return (i: number, first: boolean) => {
      const resize = first || cadence(market, i + 1, rule.rebalanceDays)
      if (resize) {
        target.fill(0)
        rank.length = 0
        for (const [j, { bar, contiguous }] of coins.entries()) {
          if (contiguous[i] <= length || !(rankVol[j][i] > 0)) continue
          const r = Math.log(bar.close[i] / bar.close[i - length])
          const eligible = rule.filter === 'return' ? r > 0 : sma[j][i] > 0 && bar.close[i] > sma[j][i]
          rank.push({ j, score: r / rankVol[j][i], eligible })
        }
        rank.sort((a, b) => b.score - a.score || a.j - b.j)
        for (const pick of rank.slice(0, rule.top)) if (pick.eligible) target[pick.j] = 1 / rule.top
      } else {
        for (const [j, { bar }] of coins.entries()) if (bar.close[i] === 0) target[j] = 0
      }
      return { target, resize, band: 'absolute' as const }
    }
  }
  const peak = new Float64Array(coins.length)
  const sinceExit = new Int32Array(coins.length).fill(-10_000)
  const moving = rule.kind === 'ema' || rule.kind === 'parity'
  const wants = coins.map((coin, j) => {
    if (moving) {
      const fast = coin.ema(toBars(rule.fast))
      const slow = coin.ema(toBars(rule.slow))
      return (i: number, ready: boolean) => ready && slow[i] > 0 && fast[i] > slow[i]
    }
    const high = coin.high(toBars(rule.entry))
    const low = coin.low(toBars(rule.exit))
    const atr = coin.atr(toBars(trend.atrHours))
    const isSqueeze = rule.kind === 'compression'
    const shortVol = isSqueeze ? coin.vol(toBars(compression.shortHours)) : null
    const longVol = isSqueeze ? coin.vol(toBars(compression.longHours)) : null
    const stop = isSqueeze ? compression.stopAtr : rule.stop
    return (i: number, ready: boolean) => {
      if (!ready) {
        if (peak[j] > 0) sinceExit[j] = i
        peak[j] = 0
        return false
      }
      const close = coin.bar.close[i]
      if (peak[j] > 0) {
        peak[j] = Math.max(peak[j], coin.bar.high[i])
        if (
          close > 0 &&
          low[i] > 0 &&
          close >= low[i] &&
          (stop === null || (atr[i] > 0 && close >= peak[j] - atr[i] * stop))
        )
          return true
        peak[j] = 0
        sinceExit[j] = i
        return false
      }
      if (!(high[i] > 0 && close > high[i] && (stop === null || atr[i] > 0))) return false
      if (rule.kind === 'compression') {
        const weekday = (market.start / dayMs + Math.floor((i + 1) / barsPerDay) + 4) % 7
        if (rule.weekend && weekday !== 6 && weekday !== 0) return false
        if (
          shortVol === null ||
          longVol === null ||
          !(shortVol[i - 1] > 0 && shortVol[i - 1] < rule.ratio * longVol[i - 1]) ||
          i - sinceExit[j] < toBars(compression.cooldownHours)
        ) {
          return false
        }
      }
      peak[j] = close
      return true
    }
  })
  const btc = coins[0]
  const btcFast = rule.kind === 'parity' && rule.btcGate ? btc?.ema(toBars(rule.fast)) : undefined
  const btcSlow = rule.kind === 'parity' && rule.btcGate ? btc?.ema(toBars(rule.slow)) : undefined
  return (i: number, first: boolean) => {
    const resize = first || cadence(market, i + 1, rule.kind === 'parity' ? 7 : trend.resizeDays)
    let gross = 0
    for (let j = 0; j < coins.length; j++) {
      const budget = rule.kind === 'compression' ? 0.2 : rule.target
      const ready =
        vol[j][i] > 0 && (btcFast === undefined || btcSlow === undefined || (btcSlow[i] > 0 && btcFast[i] > btcSlow[i]))
      const size = wants[j](i, ready) ? budget / vol[j][i] / coins.length : 0
      target[j] = rule.kind === 'parity' ? size : Math.min(size, 1 / coins.length)
      gross += target[j]
    }
    if (gross > 1) for (let j = 0; j < coins.length; j++) target[j] /= gross
    return { target, resize, band: 'relative' as const }
  }
}

export type FeeSeries = Record<(typeof fees)[number], readonly Day[]>
export const simulate = (
  prepared: Prepared,
  strategy: Trial | 'btc' | 'equal',
  window: readonly [string, string],
  omit?: string,
): FeeSeries => {
  const { market } = prepared
  const from = barIndex(market, window[0])
  const until = barIndex(market, window[1])
  if (!Number.isInteger(from) || !Number.isInteger(until) || from < 0 || until > market.count || from >= until) {
    throw new Error(`Window outside loaded dataset: ${window.join('..')}`)
  }
  const names = (strategy === 'btc' ? [symbols[0]] : strategy === 'equal' ? symbols : roster(strategy.universe)).filter(
    (name) => name !== omit,
  )
  const coins = names.map((name) => {
    const value = prepared.coins.get(name)
    if (value === undefined) throw new Error(`Missing market column: ${name}`)
    return value
  })
  const decide = typeof strategy === 'string' ? null : signal(market, coins, strategy)
  const benchmark = decide === null
  const weights = new Float64Array(coins.length).fill(benchmark ? 1 / coins.length : 0)
  const marks = new Float64Array(coins.length)
  const observed = new Uint8Array(coins.length)
  const books = fees.map((fee) => newBook(fee, coins.length))
  for (let i = from; i < until; i++) {
    const decision = i > 0 && decide !== null ? decide(i - 1, i === from) : null
    for (let j = 0; j < coins.length; j++) {
      const open = coins[j].bar.open[i]
      observed[j] = open > 0 ? 1 : 0
      if (open > 0) marks[j] = open
    }
    for (const book of books) {
      const equity = nav(book, marks)
      recordMark(book, equity)
      rebalance(
        book,
        marks,
        observed,
        decision?.target ?? weights,
        equity,
        decision?.resize ?? false,
        decision?.band ?? 'relative',
        false,
        benchmark,
      )
      recordMark(book, nav(book, marks))
      for (let j = 0; j < coins.length; j++) {
        if (book.units[j] === 0) continue
        book.day.heldBars++
        if (observed[j] === 0) book.day.staleBars++
      }
    }
    for (let j = 0; j < coins.length; j++) {
      const close = coins[j].bar.close[i]
      if (close > 0) marks[j] = close
    }
    for (const book of books) {
      let equity = nav(book, marks)
      recordMark(book, equity)
      if (i === until - 1) {
        rebalance(book, marks, observed, weights, equity, true, 'relative', true, benchmark)
        book.day.unsettled = book.units.reduce((n, units) => n + (units > 0 ? 1 : 0), 0)
        equity = nav(book, marks)
        recordMark(book, equity)
      }
      if ((i + 1) % market.barsPerDay === 0) {
        book.history.push(book.day)
        book.priorClose = equity
        book.day = startDay()
      }
    }
  }
  return { 50: books[0].history, 30: books[1].history, 20: books[2].history }
}
