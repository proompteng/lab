import { barOffset, Field, type Day, type Panel } from './sip-statarb-data'
import {
  grossCapUsd,
  costs,
  sellFeeBps,
  trialId,
  wdcReset,
  type Cost,
  type Signal,
  type Trial,
  type Universe,
} from './sip-statarb-protocol'

type Side = 1 | -1
interface PriorDay {
  readonly close: number
  readonly rangeRatio: number
  readonly returnRatio: number
}
interface Series {
  readonly vwap: Float64Array
  readonly atr: number
  readonly inverseVol: number
}
type History = PriorDay[][]

const mean = (values: readonly number[]) => values.reduce((sum, n) => sum + n, 0) / values.length
export const buildFeatures = (day: Day, panel: Pick<Panel, 'symbols' | 'spy'>, history: History) => {
  const spyReturns = history[panel.spy]
  const marketMultiplier =
    spyReturns.length < 20
      ? 0
      : Math.max(0.25, Math.min(1, 0.01 ** 2 / mean(spyReturns.map((past) => past.returnRatio ** 2))))
  const features = panel.symbols.map((symbol, id): Series => {
    const prior = history[id]
    if (symbol === 'WDC' && day.date === wdcReset) prior.length = 0
    const atr = prior.length < 14 ? 0 : mean(prior.slice(-14).map((past) => past.rangeRatio))
    const returns = prior.slice(-14).map((past) => past.returnRatio)
    const center = mean(returns)
    const vol = returns.length < 14 ? 0 : Math.sqrt((mean(returns.map((r) => (r - center) ** 2)) * 14) / 13)
    const vwap = new Float64Array(day.slots)
    let volPx = 0
    let volume = 0
    let high = 0
    let low = Infinity
    const open = day.tape[barOffset(id, 0) + Field.Open]
    for (let slot = 0; slot < day.slots; slot++) {
      const offset = barOffset(id, slot)
      const shares = day.tape[offset + Field.Volume]
      if (shares === 0) break
      volume += shares
      volPx += shares * day.tape[offset + Field.Vwap]
      vwap[slot] = volPx / volume
      high = Math.max(high, day.tape[offset + Field.High])
      low = Math.min(low, day.tape[offset + Field.Low])
    }
    if (vwap[day.slots - 1] > 0) {
      const close = day.tape[barOffset(id, day.slots - 1) + Field.Close]
      const previous = prior.at(-1)?.close ?? open
      prior.push({
        close,
        rangeRatio: Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous)) / open,
        returnRatio: close / open - 1,
      })
      if (prior.length > (id === panel.spy ? 20 : 14)) prior.shift()
    }
    return { vwap, atr, inverseVol: 1 / Math.max(0.0025, vol) }
  })
  return { features, marketMultiplier }
}

interface Rank {
  readonly id: number
  readonly score: number
  readonly deviation: number
}
interface CrossSection {
  readonly longs: readonly Rank[]
  readonly shorts: readonly Rank[]
  readonly deviations: readonly Rank[]
  readonly demean: boolean
}
const deviation = (day: Day, features: readonly Series[], id: number, slot: number) => {
  const vwap = features[id]?.vwap[slot]
  return vwap > 0 ? day.tape[barOffset(id, slot) + Field.Close] / vwap - 1 : NaN
}

export const rankCrossSection = (
  day: Day,
  panel: Pick<Panel, 'spy' | 'sector'>,
  features: readonly Series[],
  ids: readonly number[],
  entry: number,
  signal: Signal,
): CrossSection => {
  const slot = entry - 1
  const ranks: Rank[] = []
  const spyDev = signal === 'spy' ? deviation(day, features, panel.spy, slot) : 0
  for (const id of ids) {
    const feature = features[id]
    if (feature.atr <= 0) continue
    const dev = deviation(day, features, id, slot)
    if (!Number.isFinite(dev)) continue
    const open = day.tape[barOffset(id, 0) + Field.Open]
    const close = day.tape[barOffset(id, slot) + Field.Close]
    let score: number
    switch (signal) {
      case 'spy':
        score = dev - spyDev
        break
      case 'median':
        score = dev
        break
      case 'sector':
        score = dev - deviation(day, features, panel.sector[id], slot)
        break
      case 'from-open':
        score = close / open - 1
        break
      case 'vwap-z':
        score = (close - feature.vwap[slot]) / (feature.atr * open)
        break
    }
    if (Number.isFinite(score)) ranks.push({ id, score, deviation: dev })
  }
  return {
    longs: ranks.toSorted((a, b) => a.score - b.score || a.id - b.id),
    shorts: ranks.toSorted((a, b) => b.score - a.score || a.id - b.id),
    deviations: ranks.toSorted((a, b) => a.deviation - b.deviation || a.id - b.id),
    demean: signal === 'median' || signal === 'from-open',
  }
}

const quantile = (ordered: readonly Rank[], p: number, value: 'score' | 'deviation') => {
  if (ordered.length === 0) return 0
  const index = (ordered.length - 1) * p
  const lo = ordered[Math.floor(index)][value]
  return lo + (index % 1) * (ordered[Math.ceil(index)][value] - lo)
}

export const selectBasket = (
  section: CrossSection,
  pairs: number,
  omitted = -1,
  held: ReadonlySet<number> | null = null,
) => {
  const eligible = (row: Rank) => row.id !== omitted && held?.has(row.id) !== true
  const mustFilter = omitted >= 0 || held !== null
  const ascending = mustFilter ? section.longs.filter(eligible) : section.longs
  const dispersion = mustFilter ? section.deviations.filter(eligible) : section.deviations
  const center = section.demean ? quantile(ascending, 0.5, 'score') : 0
  const iqr = quantile(dispersion, 0.75, 'deviation') - quantile(dispersion, 0.25, 'deviation')
  const longs: number[] = []
  const shorts: number[] = []
  for (const rank of ascending) {
    if (rank.score >= center || longs.length === pairs) break
    longs.push(rank.id)
  }
  for (const rank of section.shorts) {
    if (rank.score <= center || shorts.length === longs.length) break
    if (eligible(rank)) shorts.push(rank.id)
  }
  longs.length = shorts.length
  return { longs, shorts, iqr }
}

export type ExitReason = 'stop' | 'target' | 'vwap-cross' | 'timed'
interface Path {
  readonly entry: number
  readonly exit: number
  readonly reason: ExitReason | null
  readonly gaps: number
}
export const replayLeg = (
  day: Day,
  series: Series,
  id: number,
  side: Side,
  entrySlot: number,
  flattenSlot: number,
  mode: Trial['exit'],
): Path | null => {
  const entry = day.tape[barOffset(id, entrySlot) + Field.Open]
  if (entry === 0) return null
  const atrUsd = series.atr * day.tape[barOffset(id, 0) + Field.Open]
  const stop = entry - side * (mode === 'atr' ? 1.5 * atrUsd : entry * (mode === 'wide' ? 0.05 : 0.15))
  const target = entry + side * (mode === 'atr' ? 2.5 * atrUsd : entry * 0.08)
  const bracket = mode === 'atr' || mode === 'wide'
  let gaps = 0
  let pendingCross = false
  for (let slot = entrySlot; slot < day.slots; slot++) {
    const offset = barOffset(id, slot)
    const open = day.tape[offset + Field.Open]
    if (open === 0) {
      gaps++
      continue
    }
    if (side * (open - stop) <= 0) return { entry, exit: open, reason: 'stop', gaps }
    if (pendingCross || slot >= flattenSlot)
      return { entry, exit: open, reason: pendingCross ? 'vwap-cross' : 'timed', gaps }
    if (bracket && side * (open - target) >= 0) return { entry, exit: target, reason: 'target', gaps }
    const adverse = day.tape[offset + (side === 1 ? Field.Low : Field.High)]
    const favorable = day.tape[offset + (side === 1 ? Field.High : Field.Low)]
    if (side * (adverse - stop) <= 0) return { entry, exit: stop, reason: 'stop', gaps }
    if (bracket && side * (favorable - target) >= 0) return { entry, exit: target, reason: 'target', gaps }
    const vwap = series.vwap[slot]
    if (mode === 'cross' && vwap > 0 && side * (day.tape[offset + Field.Close] - vwap) >= 0) pendingCross = true
  }
  return { entry, exit: 0, reason: null, gaps }
}

const newOutcome = () => ({
  gross: 0,
  sellReference: 0,
  turnover: 0,
  entryGross: 0,
  attempted: 0,
  opened: 0,
  unresolved: 0,
  heldGaps: 0,
  orphanWaves: 0,
  stops: 0,
  targets: 0,
  crosses: 0,
  timed: 0,
})
export type Outcome = ReturnType<typeof newOutcome>
export const executionCost = (day: Outcome, cost: Cost) => {
  const slippage = cost / 20_000
  return {
    slippage: slippage * day.turnover,
    sellFees: (sellFeeBps / 10_000) * day.sellReference * (1 - slippage),
  }
}
export const netFor = (day: Outcome, cost: Cost): number | null => {
  const { slippage, sellFees } = executionCost(day, cost)
  return day.unresolved > 0 ? null : day.gross - slippage - sellFees
}

export type ReplayDays = { readonly main: Outcome[]; readonly loso: Map<number, Float64Array> }
export const replay = (panel: Panel, trials: readonly Trial[], auditLoso: boolean, signal?: AbortSignal) => {
  const history: History = panel.symbols.map(() => [])
  const ledgers = new Map<string, ReplayDays>(
    trials.map((trial) => [
      trialId(trial),
      {
        main: [],
        loso: new Map(
          auditLoso
            ? panel.universes[trial.universe].map((id) => [id, new Float64Array(panel.days.length * costs.length)])
            : [],
        ),
      },
    ]),
  )
  for (const [dayIndex, day] of panel.days.entries()) {
    signal?.throwIfAborted()
    const { features, marketMultiplier } = buildFeatures(day, panel, history)
    const rankings = new Map<string, CrossSection>()
    const paths = new Map<number, Path | null>()
    const pending = new Map<string, ReturnType<typeof selectBasket>>()
    const pick = (
      universe: Universe,
      signalType: Signal,
      pairs: number,
      entry: number,
      omitted: number,
      excluded: ReadonlySet<number> | null,
    ) => {
      const key = `${universe}/${signalType}/${entry}`
      let section = rankings.get(key)
      if (section === undefined) {
        section = rankCrossSection(day, panel, features, panel.universes[universe], entry, signalType)
        rankings.set(key, section)
      }
      if (excluded !== null) return selectBasket(section, pairs, omitted, excluded)
      const selection = `${key}/${pairs}/${omitted}`
      let basket = pending.get(selection)
      if (basket === undefined) {
        basket = selectBasket(section, pairs, omitted)
        pending.set(selection, basket)
      }
      return basket
    }
    const simulate = (trial: Trial, omitted: number) => {
      const outcome = newOutcome()
      const wave = (entry: number, end: number, fraction: number, excluded: ReadonlySet<number> | null) => {
        const flatten = Math.min(end, day.slots - 1)
        if (entry >= flatten) return null
        const basket = pick(trial.universe, trial.signal, trial.pairs, entry, omitted, excluded)
        if (basket.longs.length === 0 || (trial.gateBps > 0 && 10_000 * basket.iqr <= trial.gateBps)) return null
        const scale =
          trial.sizing === 'nagel'
            ? Math.min(1, basket.iqr / 0.0075)
            : trial.sizing === 'moreira-muir'
              ? marketMultiplier
              : 1
        if (scale === 0) return null
        const maxPerSide = (fraction * grossCapUsd * scale * basket.longs.length) / (2 * trial.pairs)
        const countBefore = outcome.opened
        const place = (ids: readonly number[], side: Side) => {
          const inverse = trial.sizing === 'inverse-vol'
          const denominator = inverse ? ids.reduce((sum, id) => sum + features[id].inverseVol, 0) : ids.length
          for (const id of ids) {
            outcome.attempted++
            // Mixed radix; fixed limits are the archive's 62 symbols, 78 slots, four exit modes, two sides.
            const exitMode = trial.exit === 'wide' ? 0 : trial.exit === 'atr' ? 1 : trial.exit === 'cross' ? 2 : 3
            const key = (((id * 78 + entry) * 78 + flatten) * 4 + exitMode) * 2 + (side === 1 ? 1 : 0)
            let path = paths.get(key)
            if (path === undefined) {
              path = replayLeg(day, features[id], id, side, entry, flatten, trial.exit)
              paths.set(key, path)
            }
            if (path === null) continue
            const notional = (maxPerSide * (inverse ? features[id].inverseVol : 1)) / denominator
            outcome.opened++
            outcome.entryGross += notional
            outcome.heldGaps += path.gaps
            if (path.reason === null) {
              outcome.unresolved++
              continue
            }
            const qty = notional / path.entry
            outcome.gross += side * qty * (path.exit - path.entry)
            outcome.turnover += notional + qty * path.exit
            outcome.sellReference += side === 1 ? qty * path.exit : notional
            switch (path.reason) {
              case 'stop':
                outcome.stops++
                break
              case 'target':
                outcome.targets++
                break
              case 'vwap-cross':
                outcome.crosses++
                break
              case 'timed':
                outcome.timed++
                break
            }
          }
        }
        place(basket.longs, 1)
        place(basket.shorts, -1)
        const filled = outcome.opened - countBefore
        if (filled > 0 && filled < 2 * basket.longs.length) outcome.orphanWaves++
        return basket
      }
      if (trial.timing === 'single') {
        wave(trial.entry, day.slots - 1, 1, null)
      } else {
        const first = wave(trial.entry, 48, 0.5, null)
        const excluded = first === null ? null : new Set([...first.longs, ...first.shorts])
        wave(trial.entry + 18, day.slots - 1, 0.5, excluded)
      }
      return outcome
    }
    for (const trial of trials) {
      const ledger = ledgers.get(trialId(trial))
      if (ledger === undefined) throw new Error('Registered trial has no ledger')
      ledger.main.push(simulate(trial, -1))
      for (const [omitted, net] of ledger.loso) {
        const result = simulate(trial, omitted)
        for (const [i, cost] of costs.entries()) net[dayIndex * costs.length + i] = netFor(result, cost) ?? NaN
      }
    }
  }
  return ledgers
}
