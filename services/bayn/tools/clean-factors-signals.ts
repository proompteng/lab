import { historyStarts, rtxExit, sectors } from './clean-factors-data'
import type { Sector, Tape } from './clean-factors-data'
import type { Equity, Overlay } from './clean-factors-grid'

const assetGroups = [
  ['SPY', 'QQQ', 'IWM', 'SMH'],
  sectors.filter((sector) => sector !== 'XLRE'),
  ['TLT', 'IEF', 'SHY'],
  ['HYG', 'LQD'],
  ['GLD', 'SLV', 'USO', 'DBC'],
  ['EFA', 'EEM'],
  ['VNQ', 'XLRE'],
] as const

export function regression(y: readonly number[], x: readonly number[], end: number, n: number, z?: readonly number[]) {
  let sy = 0,
    sx = 0,
    sz = 0,
    yy = 0,
    xx = 0,
    zz = 0,
    xy = 0,
    yz = 0,
    xz = 0
  for (let i = end - n + 1; i <= end; i++) {
    const a = y[i],
      b = x[i],
      c = z?.[i] ?? 0
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return undefined
    sy += a
    sx += b
    sz += c
    yy += a * a
    xx += b * b
    zz += c * c
    xy += a * b
    yz += a * c
    xz += b * c
  }
  yy -= (sy * sy) / n
  xx -= (sx * sx) / n
  zz -= (sz * sz) / n
  xy -= (sx * sy) / n
  yz -= (sy * sz) / n
  xz -= (sx * sz) / n
  const denominator = z !== undefined ? xx * zz - xz * xz : xx
  if (denominator <= 1e-12) return undefined
  const beta = z !== undefined ? (xy * zz - yz * xz) / denominator : xy / denominator
  const sectorBeta = z !== undefined ? (yz * xx - xy * xz) / denominator : 0
  return {
    beta,
    residualVol: Math.sqrt(Math.max(0, yy - beta * xy - sectorBeta * yz) / (n - (z !== undefined ? 3 : 2))),
  }
}

export function buildSignals(tape: Tape) {
  const overlaySymbols: readonly string[] = assetGroups.flat()
  if (
    overlaySymbols.length !== tape.universe.etfs.length ||
    tape.universe.etfs.some((s) => !overlaySymbols.includes(s))
  ) {
    throw new Error('Registered ETF groups must match manifest')
  }
  const features = new Map(
    [...tape.bars].map(([symbol, bars]) => {
      const starts = historyStarts(tape, symbol)
      const close = bars.map((bar, i) => (starts[i] <= i ? (bar?.close ?? NaN) : NaN))
      const logReturns = close.map((value, i) => (starts[i] < i ? Math.log(value / close[i - 1]) : NaN))
      const high = close.map((value, i) => {
        if (i - starts[i] < 251) return NaN
        let peak = 0
        for (let j = i - 251; j <= i; j++) peak = Math.max(peak, bars[j]?.high ?? NaN)
        return value / peak
      })
      const mean = (n: number) =>
        close.map((_, i) => {
          if (i - starts[i] < n - 1) return NaN
          let total = 0
          for (let j = i - n + 1; j <= i; j++) total += close[j]
          return total / n
        })
      const mom = (n: number, skip = 0) =>
        close.map((_, i) => (i - starts[i] >= n ? close[i - skip] / close[i - n] - 1 : NaN))
      const closeHigh = close.map((value, i) =>
        i - starts[i] < 251 ? NaN : value / Math.max(...close.slice(i - 251, i + 1)),
      )
      return [
        symbol,
        {
          close,
          closeHigh,
          high,
          logReturns,
          sma50: mean(50),
          sma100: mean(100),
          sma200: mean(200),
          trend126: mom(126),
          trend252: mom(252),
          momentum: mom(252, 21),
        },
      ] as const
    }),
  )
  const spy = features.get('SPY')
  const hyg = features.get('HYG')
  if (spy === undefined || hyg === undefined) throw new Error('Missing SPY/HYG features')
  const stocks = [...tape.universe.sectorByStock].map(([symbol, sector]) => {
    const f = features.get(symbol)
    const sectorFeatures = features.get(sector)
    if (f === undefined || sectorFeatures === undefined) throw new Error(`Missing features for ${symbol}/${sector}`)
    const beta = f.logReturns.map((_, i) => regression(f.logReturns, spy.logReturns, i, 126)?.beta ?? NaN)
    const idio = f.logReturns.map(
      (_, i) => regression(f.logReturns, spy.logReturns, i, 60, sectorFeatures.logReturns)?.residualVol ?? NaN,
    )
    return { symbol, sector, ...f, beta, idio }
  })
  const stockFeatures = new Map(stocks.map((stock) => [stock.symbol, stock]))
  const crash = tape.dates.map((_, i) => {
    const window = spy.logReturns.slice(Math.max(0, i - 19), i + 1)
    return spy.closeHigh[i] < 0.85 && volatility(window) * Math.sqrt(252) > 0.25
  })
  return {
    features,
    stocks,
    stockFeatures,
    crash,
    regime: tape.dates.map((_, i) => spy.close[i] < spy.sma200[i] || hyg.close[i] < hyg.sma200[i]),
  }
}

export type Signals = ReturnType<typeof buildSignals>
export type Weights = Map<string, number>
type Rank = { symbol: string; sector: Sector; score: number; beta: number; idio: number; bear: boolean }
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
export const volatility = (xs: readonly number[]) => {
  const mean = sum(xs) / xs.length
  return Math.sqrt(sum(xs.map((x) => (x - mean) ** 2)) / (xs.length - 1))
}

export const bearish = (signals: Signals, symbol: string, day: number, sma: number) => {
  const f = signals.stockFeatures.get(symbol)
  return f !== undefined && f.close[day] < (sma === 50 ? f.sma50[day] : f.sma100[day])
}

// Retain incumbents within the wider rank band before filling new slots.
function buffered(ranking: Rank[], k: number, held: Weights, sign: number) {
  const retained = ranking
    .slice(0, k + Math.ceil(k / 2))
    .filter((x) => (held.get(x.symbol) ?? 0) * sign > 0)
    .slice(0, k)
  const retainedSymbols = new Set(retained.map((x) => x.symbol))
  return [...retained, ...ranking.filter((x) => !retainedSymbols.has(x.symbol)).slice(0, k - retained.length)]
}

const byScore = (direction: 1 | -1) => (a: Rank, b: Rank) =>
  direction * (a.score - b.score) || a.symbol.localeCompare(b.symbol)

function sectorsWithSlots(ranked: Rank[], k: number, shortable: (row: Rank) => boolean) {
  const buckets = sectors.map((sector) => {
    const members = ranked.filter((x) => x.sector === sector)
    const raw = (k * members.length) / ranked.length
    const capacity = Math.min(Math.floor(members.length / 2), members.filter(shortable).length)
    return { members, slots: Math.min(capacity, Math.floor(raw)), capacity, raw }
  })
  let remaining = k - sum(buckets.map((b) => b.slots))
  while (remaining > 0) {
    const bucket = buckets.filter((b) => b.slots < b.capacity).sort((a, b) => b.raw - b.slots - (a.raw - a.slots))[0]
    if (bucket === undefined) break
    bucket.slots++
    remaining--
  }
  return buckets
}

export function equityWeights(
  spec: Equity,
  signals: Signals,
  day: number,
  executionDate: string,
  held: Weights,
  omit?: Sector,
) {
  const inputs = signals.stocks.filter((s) => s.sector !== omit && !(s.symbol === 'RTX' && executionDate === rtxExit))
  const fields = inputs.flatMap((s) => {
    const beta = s.beta[day]
    const nearHigh = s.high[day]
    const idio = s.idio[day]
    const score = spec.factor === 'momentum' ? s.momentum[day] : spec.factor === 'bab' ? -beta : nearHigh
    if (
      !Number.isFinite(score) ||
      (spec.factor === 'quality' && !Number.isFinite(idio)) ||
      ((spec.book === 'regime-hedged' || spec.book === 'beta-hedged') && !Number.isFinite(beta))
    )
      return []
    return [
      {
        symbol: s.symbol,
        sector: s.sector,
        score,
        idio,
        beta,
        bear:
          (spec.sma > 0 || spec.factor === 'quality') && bearish(signals, s.symbol, day, spec.sma > 0 ? spec.sma : 100),
      },
    ]
  })
  const n = fields.length
  const target: Weights = new Map()
  if (n < spec.k) return target
  const ranked = fields.map((row) => ({ ...row }))
  if (spec.factor === 'quality') {
    const high = fields.map((s) => s.score)
    const idio = fields.map((s) => s.idio)
    const meanHigh = sum(high) / n
    const meanIdio = sum(idio) / n
    const volHigh = volatility(high)
    const volIdio = volatility(idio)
    if (!(volHigh > 0 && volIdio > 0)) return target
    for (const row of ranked) row.score = (row.score - meanHigh) / volHigh - (row.idio - meanIdio) / volIdio
  }
  const put = (rows: Rank[], weight: number) => {
    for (const row of rows) target.set(row.symbol, weight)
  }
  if (spec.book === 'sector-neutral') {
    const sortedIdio = fields.map((s) => s.idio).sort((a, b) => a - b)
    const medianIdio = (sortedIdio[Math.floor((n - 1) / 2)] + sortedIdio[Math.floor(n / 2)]) / 2
    const shortable = (row: (typeof ranked)[number]) =>
      spec.factor !== 'quality' || (row.bear && row.idio >= medianIdio)
    for (const { members, slots } of sectorsWithSlots(ranked, spec.k, shortable)) {
      if (slots === 0) continue
      const shorts = buffered(members.filter(shortable).sort(byScore(1)), slots, held, -1)
      const shortNames = new Set(shorts.map((x) => x.symbol))
      const longs = buffered(members.filter((x) => !shortNames.has(x.symbol)).sort(byScore(-1)), slots, held, 1)
      put(longs, 0.5 / spec.k)
      put(shorts, -0.5 / spec.k)
    }
    return target
  }
  const longs = buffered(ranked.toSorted(byScore(-1)), spec.k, held, 1)
  if (spec.book !== 'dollar-neutral') {
    const longWeight = 0.75 / spec.k
    put(longs, longWeight)
    const beta = sum(longs.map((s) => s.beta)) * longWeight
    if (spec.book === 'beta-hedged') target.set('SPY', -Math.max(0, Math.min(0.75, beta)))
    if (spec.book === 'regime-hedged' && signals.regime[day])
      target.set('SPY', -Math.max(0, Math.min(0.375, beta * 0.5)))
    return target
  }
  const longNames = new Set(longs.map((x) => x.symbol))
  const bottom = ranked.filter((x) => !longNames.has(x.symbol)).sort(byScore(1))
  // When a high-beta or momentum loser is above its SMA, omit it rather than filling the slot with another name.
  const shorts = buffered(bottom, spec.k, held, -1).filter((x) => spec.sma === 0 || x.bear)
  if (spec.factor === 'bab') {
    if (shorts.length === 0) return target
    const averageBeta = (rows: Rank[]) => sum(rows.map((r) => Math.max(0.2, 0.67 * r.beta + 0.33))) / rows.length
    const [longBeta, shortBeta] = [averageBeta(longs), averageBeta(shorts)]
    const gross = shorts.length / spec.k
    put(longs, (gross * shortBeta) / (longBeta + shortBeta) / longs.length)
    put(shorts, (-gross * longBeta) / (longBeta + shortBeta) / shorts.length)
  } else {
    put(longs, 0.5 / spec.k)
    put(shorts, -0.5 / spec.k)
  }
  return target
}

export function overlayWeights(spec: Overlay, signals: Signals, day: number, held: Weights, omit?: Sector) {
  const target: Weights = new Map()
  for (const group of assetGroups) {
    for (const symbol of group) {
      if (symbol === omit) continue
      const f = signals.features.get(symbol)
      const trend = spec.horizon === 126 ? f?.trend126[day] : f?.trend252[day]
      if (trend !== undefined && trend > (held.has(symbol) ? -0.02 : 0)) {
        target.set(symbol, 1 / assetGroups.length / group.length)
      }
    }
  }
  return target
}
