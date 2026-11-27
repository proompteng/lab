// Frozen Wave 3C equations from 1731c7ede; no selection or retuning in Wave 6C.
import { borrow, costs, etfs, grossCap, indexOf, sellFee } from './multi-asset-risk-premia-protocol'
import { cap, flat, gross, sampleVol } from './multi-asset-risk-premia-signals'
import type { Session, Weights } from './multi-asset-risk-premia-signals'

const spy = indexOf('SPY')
const shy = indexOf('SHY')
const dayMs = 86_400_000
const tolerance = 1e-12

export interface Observation {
  readonly date: string
  readonly market: number
  readonly pnl: number
  readonly shySecurityPnl: number
  readonly slippageNotional: number
  readonly sellNotional: number
  readonly shortCarry: number
  readonly investedPnl: number
  readonly investedSlippageNotional: number
  readonly investedSellNotional: number
  readonly gross: number
  readonly capTrim: boolean
}

export const netReturn = (row: Observation, cost: (typeof costs)[number]) =>
  row.pnl - (cost * row.slippageNotional) / 20_000 - sellFee * row.sellNotional - row.shortCarry

export const investedReturn = (row: Observation, cost: (typeof costs)[number]) =>
  row.investedPnl - (cost * row.investedSlippageNotional) / 20_000 - sellFee * row.investedSellNotional - row.shortCarry

/** Constant-capital weights are sized only on target changes; unchanged shares drift with the next open. */
export const replay = (
  sessions: readonly Session[],
  book: readonly Weights[],
  first: number,
  last: number | undefined,
): Observation[] => {
  let marked: Weights = flat()
  let previous: Weights = flat()
  let idleShy = 0
  const rows: Observation[] = []
  const end = last ?? sessions.length - 1
  for (let i = first; i <= end; i++) {
    const terminal = i === last
    const desired = terminal ? flat() : (book[i - 1] ?? flat())
    const changed = desired.map((weight, symbol) => Math.abs(weight - previous[symbol]) > tolerance)
    const beforeCap = marked.map((value, symbol) => (changed[symbol] ? desired[symbol] : value))
    const held = cap(beforeCap)
    previous = desired
    const trade = held.map((value, symbol) => value - marked[symbol])
    const session = sessions[i]
    const next = terminal ? undefined : sessions[i + 1]
    const market = next !== undefined ? (next.bars[spy]?.open ?? NaN) / (session.bars[spy]?.open ?? NaN) - 1 : 0
    if (!Number.isFinite(market)) throw new Error(`Missing SPY open on ${session.date}`)
    const days = next !== undefined ? (Date.parse(next.date) - Date.parse(session.date)) / dayMs : 0
    let pnl = 0
    let shySecurityPnl = 0
    let sellNotional = 0
    let shortCarry = 0
    marked = held.map((value, symbol) => {
      const delta = trade[symbol]
      if (delta < 0) sellNotional -= delta
      if (value < 0) shortCarry -= (value * borrow * days) / 365
      if (value === 0 && delta === 0) return 0
      const open = session.bars[symbol]?.open
      if (open === undefined) throw new Error(`Missing execution open for ${etfs[symbol]} on ${session.date}`)
      if (next === undefined || value === 0) return value
      const nextOpen = next.bars[symbol]?.open
      if (nextOpen === undefined) throw new Error(`Missing mark for ${etfs[symbol]} on ${next.date}`)
      const change = value * (nextOpen / open - 1)
      pnl += change
      if (symbol === shy) shySecurityPnl += change
      return value + change
    })

    const exposure = gross(held)
    const capTrim = gross(beforeCap) > grossCap + tolerance
    const available = Math.max(0, 1 - exposure)
    // Buy SHY on entry or a strategy rebalance; otherwise trim only if unencumbered capital shrinks.
    const overlay = terminal ? 0 : i === first || changed.some(Boolean) ? available : Math.min(idleShy, available)
    const overlayTrade = overlay - idleShy
    const netShyTrade = trade[shy] + overlayTrade
    const shyReturn = next !== undefined ? (next.bars[shy]?.open ?? NaN) / (session.bars[shy]?.open ?? NaN) - 1 : 0
    if (!Number.isFinite(shyReturn)) throw new Error(`Missing SHY open on ${session.date}`)
    idleShy = overlay * (1 + shyReturn)
    const turnover = gross(trade)
    rows.push({
      date: session.date,
      market,
      pnl,
      shySecurityPnl,
      slippageNotional: turnover,
      sellNotional,
      shortCarry,
      investedPnl: pnl + overlay * shyReturn,
      investedSlippageNotional: turnover - Math.abs(trade[shy]) + Math.abs(netShyTrade),
      investedSellNotional: sellNotional + Math.min(0, trade[shy]) - Math.min(0, netShyTrade),
      gross: exposure,
      capTrim,
    })
  }
  return rows
}

/** Inverse trailing paper-sleeve volatility, updated every five sessions, with no same-open observation. */
export const blend = (books: readonly (readonly Weights[])[], sessions: readonly Session[]): Weights[] => {
  if (books.length === 0) return []
  const papers = books.map((book) => replay(sessions, book, 0, undefined).map((row) => netReturn(row, 10)))
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
