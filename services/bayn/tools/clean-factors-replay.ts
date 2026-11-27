import { jump, requiredBar, rtxExit } from './clean-factors-data'
import type { Sector, Tape } from './clean-factors-data'
import { capital } from './clean-factors-grid'
import type { Candidate, Equity } from './clean-factors-grid'
import { bearish, equityWeights, overlayWeights, volatility } from './clean-factors-signals'
import type { Signals, Weights } from './clean-factors-signals'

export type ReplayDay = {
  date: string
  gross: number
  traded: number
  sold: number
  borrow: number
  carry: number
  spy: number
  shyOpen: number
  previousShyOpen: number
  grossExposure: number
}
type Gap = {
  date: string
  symbol: string
  reason: 'missing-open' | 'discontinuity'
  lastClose: number
  liquidatedUnits: number
}
export type Replay = { days: ReplayDay[]; gaps: Gap[]; knownRtxExitUnits: number }

export function scaleVol(history: readonly number[], crash: boolean, targetVol: number) {
  const vol = history.length === 126 ? volatility(history) * Math.sqrt(252) : NaN
  return (vol > 0 ? Math.min(1.25, targetVol / vol) : 1) * (crash ? 0.5 : 1)
}

function sumBooks(a: Weights, b: Weights) {
  const net = new Map(a)
  for (const [symbol, units] of b) net.set(symbol, (net.get(symbol) ?? 0) + units)
  return net
}

function toUnits(tape: Tape, weights: Weights, day: number, budget: number) {
  const units: Weights = new Map()
  for (const [symbol, weight] of weights) {
    if (weight !== 0 && budget !== 0) units.set(symbol, (weight * budget) / requiredBar(tape, symbol, day).close)
  }
  return units
}

export function makeReplayer(tape: Tape, signals: Signals) {
  const time = tape.dates.map((day) => Date.parse(day) / 86_400_000)
  const shadow = new Map<string, readonly number[]>()

  function shadowPath(equity: Equity, end: number, omit?: Sector) {
    const key = `${equity.id}/${end}/${omit ?? ''}`
    const cached = shadow.get(key)
    if (cached !== undefined) return cached
    const base: Candidate = { id: equity.id, family: equity.family, equity, overlayShare: 0 }
    const { days } = run(base, { first: 0, last: end }, omit, true)
    const firstActive = days.findIndex((d) => d.grossExposure > 0)
    const path = days.map((d, i) => (firstActive >= 0 && i > firstActive ? d.gross / capital : NaN))
    shadow.set(key, path)
    return path
  }

  function run(
    candidate: Candidate,
    { first, last }: { first: number; last: number },
    omit?: Sector,
    unscaled = false,
  ): Replay {
    const { equity, overlay, overlayShare } = candidate
    const unscaledPath = equity !== undefined && equity.targetVol > 0 && !unscaled ? shadowPath(equity, last, omit) : []
    const gaps: Gap[] = []
    const days: ReplayDay[] = []
    let eqHeld: Weights = new Map()
    let etfHeld: Weights = new Map()
    let knownRtxExitUnits = 0
    let previousLong = 0,
      previousShort = 0
    for (let day = first; day <= last; day++) {
      const date = tape.dates[day]
      const decision = day - 1
      const prev = sumBooks(eqHeld, etfHeld)
      const scheduled = (cycle: number) => day === first || day % cycle === 0
      if (day === last) {
        eqHeld = new Map()
        etfHeld = new Map()
      } else if (decision >= 0) {
        if (equity !== undefined && scheduled(equity.cycle)) {
          const scale =
            equity.targetVol > 0 && !unscaled
              ? scaleVol(unscaledPath.slice(Math.max(0, day - 126), day), signals.crash[decision], equity.targetVol)
              : 1
          eqHeld = toUnits(
            tape,
            equityWeights(equity, signals, decision, date, eqHeld, omit),
            decision,
            capital * (1 - overlayShare) * scale,
          )
        }
        if (overlay !== undefined && scheduled(overlay.cycle)) {
          etfHeld = toUnits(
            tape,
            overlayWeights(overlay, signals, decision, etfHeld, omit),
            decision,
            capital * overlayShare,
          )
        }
        if (equity !== undefined && equity.sma > 0) {
          for (const [symbol, units] of eqHeld) {
            if (units < 0 && !bearish(signals, symbol, decision, equity.sma)) eqHeld.delete(symbol)
          }
        }
        if (date === rtxExit) eqHeld.delete('RTX')
      }

      let gross = 0,
        traded = 0,
        sold = 0,
        long = 0,
        short = 0
      const target = sumBooks(eqHeld, etfHeld)
      for (const symbol of new Set([...prev.keys(), ...target.keys()])) {
        const before = prev.get(symbol) ?? 0
        const after = target.get(symbol) ?? 0
        const current = tape.bars.get(symbol)?.[day]
        const previous = tape.bars.get(symbol)?.[decision]
        // Do not use a later price or invent an opening print. This is a non-executable accounting fallback.
        const reason =
          current === undefined
            ? 'missing-open'
            : previous !== undefined && jump(previous.close, current.open)
              ? 'discontinuity'
              : null
        if (reason !== null) {
          const lastClose = requiredBar(tape, symbol, decision).close
          gaps.push({ date, symbol, reason, lastClose, liquidatedUnits: before })
          eqHeld.delete(symbol)
          etfHeld.delete(symbol)
          if (before !== 0) {
            gross += before * (lastClose - requiredBar(tape, symbol, decision).open)
            traded += Math.abs(before * lastClose)
            sold += Math.max(0, before * lastClose)
          }
          continue
        }
        if (current === undefined) throw new Error(`Unreachable missing execution bar: ${symbol} ${date}`)
        if (before !== 0) gross += before * (current.open - requiredBar(tape, symbol, decision).open)
        const delta = (after - before) * current.open
        traded += Math.abs(delta)
        sold += Math.max(0, -delta)
        long += Math.max(0, after * current.open)
        short += Math.max(0, -after * current.open)
        if (symbol === 'RTX' && date === rtxExit) knownRtxExitUnits = before
      }

      const shyOpen = requiredBar(tape, 'SHY', day).open
      const elapsed = day === first ? 0 : time[day] - time[decision]
      const spy = elapsed > 0 ? requiredBar(tape, 'SPY', day).open / requiredBar(tape, 'SPY', decision).open - 1 : 0
      const previousShyOpen = elapsed > 0 ? requiredBar(tape, 'SHY', decision).open : shyOpen
      const shy = shyOpen / previousShyOpen - 1
      const borrow = (previousShort * 0.015 * elapsed) / 365
      const carry = Math.max(0, capital - previousLong - previousShort) * shy
      days.push({
        date,
        gross,
        traded,
        sold,
        borrow,
        carry,
        spy,
        shyOpen,
        previousShyOpen,
        grossExposure: long + short,
      })
      previousLong = long
      previousShort = short
    }
    return { days, gaps, knownRtxExitUnits }
  }

  return run
}
