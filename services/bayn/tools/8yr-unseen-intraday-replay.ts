import { baselineNames, benchmark, noiseNames, parameters as p, roster, stocks } from './8yr-unseen-intraday-protocol'
import { Field, isListed, price, type Day } from './8yr-unseen-intraday-tape'
import { mean, quantile } from './midday-research-statistics'

export type Id = keyof typeof roster
export const ids = Object.keys(roster) as Id[]
type Engine = 'orb' | 'reversion' | 'noise'
type Side = 1 | -1
type Bracket = { stop: number; target: number }
interface Intent {
  readonly symbol: string
  readonly engine: Engine
  readonly side: Side
  readonly signalSlot: number
  readonly cap: number
  readonly shares: number
  readonly flat: number
  readonly bracket?: (entry: number) => Bracket
  readonly reverse?: (slot: number) => boolean
}
interface Prior {
  readonly close: number
  readonly tr: number
  readonly openingVolume: number
  readonly moves: readonly number[]
}
interface Features {
  readonly prevClose: number
  readonly atr: number
  readonly rvol: number
  readonly moves: readonly number[]
}
interface Rank {
  readonly symbol: string
  readonly bps: number
}
const { barMinutes, grossCapUsd, historySessions } = p
const checkpoints = Array.from(
  { length: p.noise.lastCheckpointMinuteFromOpen / p.noise.checkpointMinutes },
  (_, i) => ((i + 1) * p.noise.checkpointMinutes) / barMinutes - 1,
)
const noon = p.reversion.decisionMinuteFromOpen / barMinutes - 1
const latestOpen = (minute: number) => Math.floor(minute / barMinutes)
const timedFlat = (day: Day, beforeCloseMinutes: number) => day.slots - Math.ceil(beforeCloseMinutes / barMinutes)
const orbFlat = (day: Day) =>
  day.slots < 390 / barMinutes
    ? timedFlat(day, p.orb.shortDayFlattenBeforeCloseMinutes)
    : latestOpen(p.orb.hardExitMinuteFromOpen)
const bySymbol = (a: string, b: string) => a.localeCompare(b, 'en')

export const createPreparation = () => {
  const history = new Map<string, Prior[]>()
  return (day: Day) => {
    const features = new Map<string, Features>()
    const deviations = new Map<string, number[]>()
    for (const symbol of [...stocks, ...noiseNames, benchmark, 'IWM']) {
      const bars = day.bars.get(symbol)
      const prior = symbol === 'WDC' && day.date === p.historyResets.WDC ? [] : (history.get(symbol) ?? [])
      const open = bars === undefined ? 0 : price(bars, 0, Field.Open)
      if (bars === undefined || open === 0 || !isListed(symbol, day.date)) {
        history.delete(symbol)
        continue
      }
      const previous = prior.at(-1)?.close ?? open
      if (prior.length === historySessions) {
        features.set(symbol, {
          prevClose: previous,
          atr: mean(prior.map(({ tr }) => tr)),
          rvol: price(bars, 0, Field.Volume) / mean(prior.map(({ openingVolume }) => openingVolume)),
          moves: checkpoints.map((_, i) =>
            prior.every(({ moves }) => Number.isFinite(moves[i])) ? mean(prior.map(({ moves }) => moves[i])) : NaN,
          ),
        })
      }
      let high = previous
      let low = previous
      let volume = 0
      let cashVolume = 0
      const rel: number[] = []
      let complete = true
      for (let slot = 0; slot < day.slots; slot++) {
        const shares = price(bars, slot, Field.Volume)
        if (shares <= 0) {
          complete = false
          break
        }
        high = Math.max(high, price(bars, slot, Field.High))
        low = Math.min(low, price(bars, slot, Field.Low))
        if (slot <= noon) {
          volume += shares
          cashVolume += shares * price(bars, slot, Field.Vwap)
          rel.push(10_000 * (price(bars, slot, Field.Close) / (cashVolume / volume) - 1))
        }
      }
      if (features.has(symbol)) deviations.set(symbol, rel)
      if (complete) {
        prior.push({
          close: price(bars, day.slots - 1, Field.Close),
          tr: high - low,
          openingVolume: price(bars, 0, Field.Volume),
          moves: checkpoints.map((slot) =>
            slot < day.slots ? Math.abs(price(bars, slot, Field.Close) / open - 1) : NaN,
          ),
        })
        if (prior.length > historySessions) prior.shift()
        history.set(symbol, prior)
      } else {
        history.delete(symbol)
      }
    }
    const activeStocks = stocks.filter((symbol) => features.has(symbol))
    const rank = (names: readonly string[], slot: number): Rank[] => {
      const spy = deviations.get(benchmark)?.[slot]
      if (spy === undefined) return []
      return names
        .flatMap((symbol) => {
          const value = deviations.get(symbol)?.[slot]
          return value === undefined ? [] : [{ symbol, bps: value - spy }]
        })
        .sort((a, b) => a.bps - b.bps || bySymbol(a.symbol, b.symbol))
    }

    const orbCandidates = activeStocks
      .flatMap((symbol) => {
        const bars = day.bars.get(symbol)
        const f = features.get(symbol)
        if (bars === undefined || f === undefined || f.atr <= 0 || f.rvol < p.orb.rvol) return []
        const open = price(bars, 0, Field.Open)
        const close = price(bars, 0, Field.Close)
        if (Math.abs(open - f.prevClose) < p.orb.gapAtr * f.atr || open === close) return []
        return [{ symbol, rvol: f.rvol, side: close > open ? (1 as const) : (-1 as const), bars }]
      })
      .sort((a, b) => b.rvol - a.rvol || bySymbol(a.symbol, b.symbol))

    const orb = (trial: (typeof roster)['C2' | 'C3_3R' | 'C3_top2'], weight: number, omit: string): Intent[] => {
      const flat = orbFlat(day)
      return orbCandidates
        .filter(({ symbol }) => symbol !== omit)
        .slice(0, trial.top)
        .flatMap(({ symbol, side, bars }) => {
          const edge = price(bars, 0, side === 1 ? Field.High : Field.Low)
          const stop = price(bars, 0, side === 1 ? Field.Low : Field.High)
          for (let slot = 1; slot + 1 < flat && price(bars, slot, Field.Open) > 0; slot++) {
            if (side * (price(bars, slot, side === 1 ? Field.High : Field.Low) - edge) <= 0) continue
            const reference = price(bars, slot, Field.Close)
            const gap = side * (reference - stop)
            if (gap <= 0) return []
            const cap = p.standaloneSymbolCapUsd * weight
            return [
              {
                symbol,
                engine: 'orb',
                side,
                signalSlot: slot,
                cap,
                shares: Math.min(cap / reference, (p.orb.riskUsd * weight) / (trial.top * gap)),
                flat,
                bracket: (entry) => ({ stop, target: entry + trial.targetR * (entry - stop) }),
              },
            ]
          }
          return []
        })
    }

    const v2OrbCandidates = baselineNames.flatMap((symbol) => {
      const bars = day.bars.get(symbol)
      const atr = features.get(symbol)?.atr
      if (bars === undefined || atr === undefined || atr <= 0) return []
      const width = p.baseline.rangeMinutes / barMinutes
      const open = price(bars, 0, Field.Open)
      const end = price(bars, width - 1, Field.Close)
      if (open === end) return []
      const side: Side = end > open ? 1 : -1
      const extremes = Array.from({ length: width }, (_, i) => price(bars, i, side === 1 ? Field.High : Field.Low))
      if (extremes.some((value) => value <= 0)) return []
      const edge = side === 1 ? Math.max(...extremes) : Math.min(...extremes)
      const [from, through] = p.baseline.orbDecisionMinutesFromOpen
      for (let slot = from / barMinutes - 1; slot < through / barMinutes; slot++) {
        const reference = price(bars, slot, Field.Close)
        if (reference === 0 || ![slot - 2, slot - 1].every((i) => price(bars, i, Field.Open) > 0)) continue
        const score = side * (reference / edge - 1)
        if (score <= 0) continue
        const stopFraction = stopBps(p.baseline.orbStopAtr, atr, reference, p.baseline.orbStopBoundsBps) / 10_000
        return [
          {
            score,
            intent: {
              symbol,
              engine: 'orb',
              side,
              signalSlot: slot,
              cap: p.baseline.orbCapUsd,
              shares: p.baseline.orbRiskUsd / (reference * stopFraction),
              flat: Math.min(orbFlat(day), slot + 1 + p.baseline.orbHoldMinutes / barMinutes),
              bracket: relativeBracket(side, stopFraction, p.baseline.orbTargetR * stopFraction),
            } satisfies Intent,
          },
        ]
      }
      return []
    })
    v2OrbCandidates.sort(
      (a, b) =>
        a.intent.signalSlot - b.intent.signalSlot || b.score - a.score || bySymbol(a.intent.symbol, b.intent.symbol),
    )

    const noonRank = rank(stocks, noon)
    const [middayStart, middayEnd] = p.baseline.reversionDecisionMinutesFromOpen
    const v2Ranks = Array.from({ length: (middayEnd - middayStart) / barMinutes + 1 }, (_, i) => {
      const slot = middayStart / barMinutes - 1 + i
      return { slot, ranked: rank(baselineNames, slot) }
    })
    const reversion = (
      slot: number,
      ranked: readonly Rank[],
      excluded: ReadonlySet<string>,
      gate: number,
      cap: number,
      brackets: boolean,
    ): Intent[] => {
      const selected = selectBasket(ranked, excluded, gate)
      return selected.map((symbol, i) => {
        const side: Side = i < p.reversion.pairs ? 1 : -1
        return {
          symbol,
          engine: 'reversion',
          side,
          signalSlot: slot,
          cap,
          shares: Infinity,
          flat: timedFlat(day, p.reversion.flattenBeforeCloseMinutes),
          ...(brackets
            ? { bracket: relativeBracket(side, p.reversion.stopBps / 10_000, p.reversion.targetBps / 10_000) }
            : {}),
        }
      })
    }

    const noise = (weight: number, omit: string, baseline: boolean): Intent[] => {
      const flat = timedFlat(day, p.noise.flattenBeforeCloseMinutes)
      const bench = noiseNames.flatMap((symbol) => {
        const bars = day.bars.get(symbol)
        const f = features.get(symbol)
        return bars === undefined || f === undefined || f.atr <= 0
          ? []
          : [{ symbol, bars, f, open: price(bars, 0, Field.Open) }]
      })
      const totalInverseAtr = bench.reduce((total, { open, f }) => total + open / f.atr, 0)
      return bench.flatMap(({ symbol, bars, f, open }) => {
        if (symbol === omit) return []
        const band = baseline ? p.baseline.noiseBand : p.noise.band
        const directionAt = (slot: number): Side | 0 => {
          const move = f.moves[checkpoints.indexOf(slot)]
          if (!(move > 0) || slot >= day.slots) return 0
          const close = price(bars, slot, Field.Close)
          if (close === 0) return 0
          if (close > Math.max(open, f.prevClose) * (1 + band * move)) return 1
          if (close < Math.min(open, f.prevClose) * (1 - band * move)) return -1
          return 0
        }
        for (const slot of checkpoints) {
          if (slot + 1 >= flat) break
          const side = directionAt(slot)
          if (side === 0) continue
          const reference = price(bars, slot, Field.Close)
          const cap = baseline
            ? clamp(
                (open / f.atr / totalInverseAtr) * p.baseline.noiseSleeveGrossUsd,
                p.baseline.noiseWeightBounds.map((value) => value * p.equityUsd),
              )
            : p.standaloneSymbolCapUsd * weight
          const shares = baseline
            ? cap / reference
            : Math.min(cap / reference, (p.noise.riskUsd * weight) / (2 * f.atr))
          return [
            {
              symbol,
              engine: 'noise',
              side,
              signalSlot: slot,
              cap,
              shares,
              flat,
              ...(baseline
                ? {
                    bracket: relativeBracket(
                      side,
                      stopBps(p.baseline.noiseStopAtr, f.atr, reference, p.baseline.noiseStopBoundsBps) / 10_000,
                      p.baseline.noiseTargetBps / 10_000,
                    ),
                  }
                : { reverse: (i: number) => directionAt(i) === -side }),
            },
          ]
        }
        return []
      })
    }

    return { day, activeStocks, orb, v2OrbCandidates, noonRank, v2Ranks, reversion, noise }
  }
}

const clamp = (n: number, bounds: readonly number[]) => Math.max(bounds[0], Math.min(bounds[1], n))
const stopBps = (multiple: number, atr: number, reference: number, bounds: readonly [number, number]) =>
  clamp(Math.round((10_000 * multiple * atr) / reference), bounds)
const relativeBracket = (side: Side, stop: number, target: number) => (entry: number) => ({
  stop: entry * (1 - side * stop),
  target: entry * (1 + side * target),
})

export const selectBasket = (ranked: readonly Rank[], excluded: ReadonlySet<string>, gate: number) => {
  const eligible = ranked.filter(({ symbol }) => !excluded.has(symbol))
  const [low, secondLow] = eligible
  const [secondHigh, high] = eligible.slice(-2)
  if (eligible.length < p.reversion.pairs * 2 || secondLow.bps >= 0 || secondHigh.bps <= 0) return []
  if (gate > 0) {
    const bps = eligible.map((item) => item.bps)
    if ((quantile(bps, 0.75) ?? 0) - (quantile(bps, 0.25) ?? 0) < gate) return []
  }
  return [low.symbol, secondLow.symbol, high.symbol, secondHigh.symbol]
}

export const exitPath = (
  bars: Float64Array,
  side: Side,
  start: number,
  flat: number,
  bracket: Bracket | undefined,
  reverse?: (slot: number) => boolean,
) => {
  let exitSlot = flat
  let heldGaps = 0
  for (let slot = start; slot < flat; slot++) {
    if (price(bars, slot, Field.Open) === 0) {
      heldGaps++
      continue
    }
    if (
      (bracket !== undefined &&
        (side * (price(bars, slot, side === 1 ? Field.Low : Field.High) - bracket.stop) <= 0 ||
          side * (price(bars, slot, side === 1 ? Field.High : Field.Low) - bracket.target) >= 0)) ||
      reverse?.(slot) === true
    ) {
      // Stop and target both settle at the same next open, even on a same-bar tie.
      exitSlot = slot + 1
      break
    }
  }
  const exit = price(bars, exitSlot, Field.Open)
  return {
    exitSlot: exit > 0 ? exitSlot : Infinity,
    exit: exit > 0 ? exit : null,
    heldGaps: heldGaps + (exit > 0 ? 0 : 1),
  }
}

export interface Pnl {
  base: number
  slope: number
}
export const netAt = (pnl: Pnl, bps: number) => pnl.base - pnl.slope * bps
export interface Ledger extends Pnl {
  trades: number
  unresolved: number
  missingEntries: number
  heldGaps: number
  peakGross: number
  readonly symbols: Map<string, Pnl>
  readonly sleeves: Record<Engine, Pnl & { unresolved: number }>
}
const zero = () => ({ base: 0, slope: 0 })
const cash = (): Ledger => ({
  ...zero(),
  trades: 0,
  unresolved: 0,
  missingEntries: 0,
  heldGaps: 0,
  peakGross: 0,
  symbols: new Map(),
  sleeves: {
    orb: { ...zero(), unresolved: 0 },
    reversion: { ...zero(), unresolved: 0 },
    noise: { ...zero(), unresolved: 0 },
  },
})
const entryMultiplier = 1 + Math.max(...p.costsRtBps) / 20_000
const fee = p.sellFeeBps / 10_000

export const replayDay = (
  prepared: ReturnType<ReturnType<typeof createPreparation>>,
  id: Id,
  omit = '',
  attribute = true,
) => {
  const variant = roster[id]
  const baseline = variant.engine === 'baseline'
  const ledger = cash()
  const day = prepared.day
  const orbWeight = variant.engine === 'orb' ? 1 : variant.engine === 'portfolio' ? variant.weights[0] : 0
  const reversionWeight = variant.engine === 'reversion' ? 1 : variant.engine === 'portfolio' ? variant.weights[1] : 0
  const noiseWeight = variant.engine === 'noise' ? 1 : variant.engine === 'portfolio' ? (variant.weights[2] ?? 0) : 0
  const v2Orb = baseline ? prepared.v2OrbCandidates.find(({ intent }) => intent.symbol !== omit)?.intent : undefined
  const orders = [
    ...(v2Orb === undefined ? [] : [v2Orb]),
    ...(orbWeight > 0 ? prepared.orb(variant.engine === 'orb' ? variant : roster.C2, orbWeight, omit) : []),
    ...(baseline || noiseWeight > 0 ? prepared.noise(noiseWeight, omit, baseline) : []),
  ].sort((a, b) => a.signalSlot - b.signalSlot)
  const held = new Map<string, { reserved: number; exitSlot: number }>()
  const available = () => Math.max(0, grossCapUsd - [...held.values()].reduce((total, leg) => total + leg.reserved, 0))

  const enter = (order: Intent, allowed: number) => {
    const bars = day.bars.get(order.symbol)
    const start = order.signalSlot + 1
    if (bars === undefined || held.has(order.symbol) || start >= order.flat) return
    const entry = price(bars, start, Field.Open)
    if (entry === 0) {
      ledger.missingEntries++
      return
    }
    const bracket = order.bracket?.(entry)
    if (bracket !== undefined && order.side * (entry - bracket.stop) <= 0) return
    const quantity = Math.min(order.shares, Math.min(allowed, order.cap) / (entry * entryMultiplier))
    const qty = order.engine === 'reversion' ? quantity : Math.floor(quantity)
    if (qty <= 0) return
    const { exit, exitSlot, heldGaps } = exitPath(bars, order.side, start, order.flat, bracket, order.reverse)
    held.set(order.symbol, { exitSlot, reserved: qty * entry * entryMultiplier })
    ledger.peakGross = Math.max(ledger.peakGross, grossCapUsd - available())
    ledger.heldGaps += heldGaps
    const sleeve = ledger.sleeves[order.engine]
    if (exit === null) {
      ledger.unresolved++
      sleeve.unresolved++
      return
    }
    const sell = order.side === 1 ? exit : entry
    const base = qty * (order.side * (exit - entry) - sell * fee)
    const slope = (qty * (entry + exit - sell * fee)) / 20_000
    ledger.trades++
    ledger.base += base
    ledger.slope += slope
    sleeve.base += base
    sleeve.slope += slope
    if (attribute) {
      const previous = ledger.symbols.get(order.symbol) ?? zero()
      ledger.symbols.set(order.symbol, { base: previous.base + base, slope: previous.slope + slope })
    }
  }

  const ranks = baseline ? prepared.v2Ranks : [{ slot: noon, ranked: prepared.noonRank }]
  const useReversion = baseline || reversionWeight > 0
  let rankIndex = 0
  let orderIndex = 0
  while (orderIndex < orders.length || (useReversion && rankIndex < ranks.length)) {
    const signalSlot = Math.min(
      orders[orderIndex]?.signalSlot ?? Infinity,
      useReversion ? (ranks[rankIndex]?.slot ?? Infinity) : Infinity,
    )
    const start = signalSlot + 1
    const excluded = new Set<string>(omit === '' ? [] : [omit])
    for (const [symbol, leg] of held) if (leg.exitSlot >= start) excluded.add(symbol)
    let end = orderIndex
    while (orders[end]?.signalSlot === signalSlot) {
      excluded.add(orders[end].symbol)
      end++
    }
    const ranked = ranks[rankIndex]?.slot === signalSlot ? ranks[rankIndex++] : undefined
    const basket =
      !useReversion || ranked === undefined
        ? []
        : prepared.reversion(
            signalSlot,
            ranked.ranked,
            excluded,
            variant.engine === 'reversion' ? variant.iqrBps : baseline ? 0 : roster.C4_timed.iqrBps,
            baseline ? p.baseline.reversionCapPerLegUsd : (reversionWeight * grossCapUsd) / (p.reversion.pairs * 2),
            baseline || (variant.engine === 'reversion' && variant.exit === 'brackets'),
          )
    if (basket.length > 0) rankIndex = ranks.length

    for (const [symbol, leg] of held) if (leg.exitSlot <= start) held.delete(symbol)
    // Stable order preserves ORB-before-Noise priority at the same open.
    while (orderIndex < end) enter(orders[orderIndex++], available())
    const noOpen = basket.filter(({ symbol }) => {
      const bars = day.bars.get(symbol)
      return bars === undefined || price(bars, start, Field.Open) === 0
    }).length
    if (noOpen > 0) ledger.missingEntries += noOpen
    else {
      const perLeg = available() / (p.reversion.pairs * 2)
      for (const leg of basket) enter(leg, perLeg)
    }
  }
  return ledger
}
