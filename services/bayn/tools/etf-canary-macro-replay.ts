import type { Session } from './etf-canary-macro-data'
import { borrow, etfs, sellFee, shy, spy, type Trial } from './etf-canary-macro-protocol'
import { executionRule } from './etf-canary-macro-signals'

const n = etfs.length
const idle = n
const dayMs = 86_400_000
const eps = 1e-12

export const marks = (sessions: readonly Session[]) =>
  sessions.map(({ open, close, date }, t) => {
    const previous = sessions[t - 1]
    const gap = Float64Array.from(open, (p, i) => (previous === undefined ? 1 : p / previous.close[i]))
    const day = Float64Array.from(close, (p, i) => p / open[i])
    const elapsed = previous === undefined ? 0 : (Date.parse(date) - Date.parse(previous.date)) / dayMs
    return { date, gap, day, elapsed, shy: gap[shy] * day[shy] - 1, spy: gap[spy] * day[spy] - 1 }
  })

export type Marks = ReturnType<typeof marks>
export type Path = { net: Float64Array; turnover: Float64Array }

export const trades = (buys: number, sells: number, roundTripBp: number) =>
  ((buys + sells) * roundTripBp) / 20_000 + sells * sellFee

export const needsTrade = (desired: number, heldAtClose: number, scheduled: boolean, band: number) =>
  scheduled
    ? desired !== 0 || heldAtClose !== 0
    : Math.abs(desired - heldAtClose) > eps && Math.abs(desired - heldAtClose) >= band

// Positions are normalized to the prior close's net equity. Mark old positions to the next open,
// use only prior-close decisions, then mark the post-trade portfolio to today's close.
export const replay = (
  prices: Marks,
  desired: readonly Float64Array[],
  trial: Trial,
  roundTripBp: number,
  sweep: boolean,
  omit: number,
): Path => {
  const net = new Float64Array(prices.length)
  const turnover = new Float64Array(prices.length)
  const held = new Float64Array(n + 1)
  const opened = new Float64Array(n + 1)
  const allocated = new Float64Array(n + 1)
  const changing = new Uint8Array(n)
  for (let t = 0; t < prices.length; t++) {
    const marks = prices[t]
    const rule = executionRule(trial, t - 1)
    const target = desired[t - 1]
    let openNav = 1
    let change = t === 0 && sweep
    for (let i = 0; i <= idle; i++) {
      const u = i === idle ? shy : i
      const prior = held[i]
      opened[i] = 0
      if (prior !== 0) {
        if (!(marks.gap[u] > 0 && marks.day[u] > 0) || !Number.isFinite(marks.gap[u] * marks.day[u]))
          throw new Error(`Unmarkable held ETF ${etfs[u]} on ${marks.date}`)
        opened[i] = prior * marks.gap[u]
        openNav += opened[i] - prior + (Math.min(prior, 0) * borrow * marks.elapsed) / 365
      }
      if (i === idle) continue
      changing[i] = Number(rule.review && needsTrade(target[i], prior, rule.scheduled, rule.band))
      change ||= changing[i] !== 0
    }
    if (!(openNav > 0)) throw new Error('Nonpositive opening equity on ' + marks.date)

    let nav = openNav
    if (change) {
      let kept = 0
      let planned = 0
      for (let i = 0; i < n; i++) {
        if (changing[i] !== 0) planned += Math.abs(target[i])
        else kept += Math.abs(opened[i])
      }
      let buys = 0
      let sells = 0
      // Solve target equity after fees. Unchanged ETF shares stay untouched; new target
      // notionals shrink pro-rata when unchanged positions occupy the gross budget.
      for (let iteration = 0; ; iteration++) {
        const room = Math.max(0, nav - kept)
        const scale = planned > 0 ? Math.min(nav, room / planned) : 0
        let gross = 0
        buys = 0
        sells = 0
        for (let i = 0; i < n; i++) {
          allocated[i] = changing[i] !== 0 ? target[i] * scale : opened[i]
          gross += Math.abs(allocated[i])
          if (i === shy) continue
          const delta = allocated[i] - opened[i]
          if (delta > 0) buys += delta
          else sells -= delta
        }
        allocated[idle] = sweep ? Math.max(0, nav - gross) : 0
        const shyDelta = allocated[shy] + allocated[idle] - opened[shy] - opened[idle]
        if (shyDelta > 0) buys += shyDelta
        else sells -= shyDelta
        const next = openNav - trades(buys, sells, roundTripBp)
        if (Math.abs(nav - next) < eps || iteration >= 12) {
          if (Math.abs(nav - next) >= eps || !(next > 0)) throw new Error('Cannot fund rebalance on ' + marks.date)
          nav = next
          break
        }
        nav = next
      }
      turnover[t] = (buys + sells) / (2 * openNav)
    } else {
      allocated.set(opened)
    }

    let closeNav = nav
    for (let i = 0; i <= idle; i++) {
      const pos = allocated[i]
      const u = i === idle ? shy : i
      if (pos === 0) {
        held[i] = 0
        continue
      }
      if (u === omit || !(marks.day[u] > 0) || !Number.isFinite(marks.day[u]))
        throw new Error(`Invalid ETF allocation ${etfs[u]} on ${marks.date}`)
      held[i] = pos * marks.day[u]
      closeNav += held[i] - pos
    }
    if (!(closeNav > 0) || !Number.isFinite(closeNav)) throw new Error('Invalid closing equity on ' + marks.date)
    for (let i = 0; i <= idle; i++) held[i] /= closeNav
    net[t] = closeNav - 1
  }
  return { net, turnover }
}
