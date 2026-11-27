import { seriesFor, type Tape, wdcExit } from './daily-alpha-data'
import { flat, type Phase, type Plan, type Planner } from './daily-alpha-signals'
import { mean, sum } from './midday-research-statistics'

export const capital = 100_000
export const costs = [2, 5, 10, 20] as const
export interface Day {
  pnl: number
  traded: number
  sold: number
  borrow: number
  active: boolean
}
interface Position {
  shares: number
  last: number
}
interface Sleeve {
  plan: Planner
  end: Phase
}
export interface Bounds {
  start: number
  end: number
}
interface EnsembleRisk {
  window: number
  // Standalone P&L starts at the same split boundary and uses the same exclusion as the net portfolio.
  histories: readonly (readonly number[])[]
}
export type Replay = { days: Day[]; peakTradeGross: number; peakMarkedGross: number; error?: never } | { error: string }

const sellRate = 0.21 / 10_000

export const netAt = (day: Day, roundTripBps: number) =>
  day.pnl - (day.traded * roundTripBps) / 20_000 - day.sold * sellRate - day.borrow

function inverseRisk(risk: EnsembleRisk, offset: number) {
  const values = risk.histories.map((history) => {
    if (offset < risk.window) return 1
    const previous = history.slice(offset - risk.window, offset)
    const center = mean(previous)
    const vol = Math.sqrt(sum(previous.map((value) => (value - center) ** 2)) / (previous.length - 1)) / capital
    return 1 / Math.max(0.0005, vol)
  })
  const total = sum(values)
  return values.map((weight) => weight / total)
}

// Virtual sleeve targets express shares per dollar of standalone equity. Actual positions and fees are netted.
export function replay(
  tape: Tape,
  bounds: Bounds,
  sleeves: readonly Sleeve[],
  omit?: string,
  risk?: EnsembleRisk,
): Replay {
  const live = new Map<string, Position>()
  const virtual = sleeves.map(() => flat)
  const days: Day[] = []
  let shortAtClose = 0
  let peakTradeGross = 0
  let peakMarkedGross = 0
  const mark = (symbol: string, index: number, phase: Phase) => tape.prices.get(symbol)?.bars[index]?.[phase]
  for (let i = bounds.start; i < bounds.end; i++) {
    const gap = i === bounds.start ? 0 : tape.calendarDays[i] - tape.calendarDays[i - 1]
    const day: Day = { pnl: 0, traded: 0, sold: 0, borrow: (shortAtClose * 0.015 * gap) / 365, active: live.size > 0 }
    const terminal = i === bounds.end - 1
    for (const phase of ['open', 'close'] as const) {
      let gross = 0
      for (const [symbol, position] of live) {
        const px = mark(symbol, i, phase)
        if (px === undefined) return { error: `Missing held ${symbol} ${phase} ${tape.dates[i]}` }
        day.pnl += position.shares * (px - position.last)
        position.last = px
        gross += Math.abs(position.shares * px)
      }
      peakMarkedGross = Math.max(peakMarkedGross, gross / capital)

      let rebalance = false
      for (const [slot, sleeve] of sleeves.entries()) {
        // An open-terminal sleeve stays flat at the final close; an intraday sleeve may trade its final day.
        const closing = terminal && (sleeve.end === phase || sleeve.end === 'open')
        const plan = closing ? flat : sleeve.plan(i, phase, omit)
        if (plan !== undefined) {
          virtual[slot] = plan
          rebalance = true
        }
        if (phase === 'close' && tape.dates[i] === wdcExit && virtual[slot].has('WDC')) {
          const trimmed = new Map(virtual[slot])
          trimmed.delete('WDC')
          virtual[slot] = trimmed
          rebalance = true
        }
      }
      if (!rebalance) continue

      let target: Plan = virtual[0]
      let scale = capital
      if (risk !== undefined) {
        const weights = inverseRisk(risk, i - bounds.start)
        const combined = new Map<string, number>()
        for (const [slot, plan] of virtual.entries()) {
          for (const [symbol, shares] of plan) {
            combined.set(symbol, (combined.get(symbol) ?? 0) + weights[slot] * shares)
          }
        }
        let targetGross = 0
        for (const [symbol, shares] of combined) {
          if (Math.abs(shares) < 1e-14) {
            combined.delete(symbol)
            continue
          }
          const reference = mark(symbol, i - 1, 'close')
          if (reference === undefined)
            return { error: `Missing ensemble sizing reference for ${symbol} ${tape.dates[i]}` }
          targetGross += Math.abs(shares * reference)
        }
        if (targetGross > 1.8) scale *= 1.8 / targetGross
        target = combined
      }
      for (const [symbol, position] of live) {
        if (target.has(symbol)) continue
        const traded = -position.shares * position.last
        day.traded += Math.abs(traded)
        day.sold += Math.max(0, -traded)
        live.delete(symbol)
      }
      let tradedGross = 0
      for (const [symbol, units] of target) {
        const px = mark(symbol, i, phase)
        if (px === undefined) return { error: `Missing fill ${symbol} ${phase} ${tape.dates[i]}` }
        const shares = units * scale
        const traded = (shares - (live.get(symbol)?.shares ?? 0)) * px
        day.traded += Math.abs(traded)
        day.sold += Math.max(0, -traded)
        tradedGross += Math.abs(shares * px)
        live.set(symbol, { shares, last: px })
      }
      peakTradeGross = Math.max(peakTradeGross, tradedGross / capital)
      peakMarkedGross = Math.max(peakMarkedGross, tradedGross / capital)
      day.active ||= live.size > 0
    }
    shortAtClose = 0
    for (const { shares, last } of live.values()) shortAtClose += Math.max(0, -shares * last)
    days.push(day)
  }
  if (live.size !== 0) throw new Error('Non-flat split termination')
  return { days, peakTradeGross, peakMarkedGross }
}

export function spyDaily(tape: Tape, start: number, length: number) {
  return [...seriesFor(tape, 'SPY').daily.subarray(start, start + length)].map(Math.expm1)
}
