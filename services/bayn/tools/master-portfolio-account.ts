import type { Plan } from './daily-alpha-signals'
import { etfs } from './master-portfolio-etf'

export const capital = 100_000
export const overnightLimit = 150_000
export const intradayLimit = 180_000
export const sellFee = 0.21 / 10_000
const borrowRate = 0.015
const debitRate = 0.065
const dayMs = 86_400_000
const etfSymbols = new Set<string>([...etfs, 'ARKK', 'XBI'])
const hyperLiquid = new Set(['SPY', 'QQQ', 'TLT', 'GLD', 'IEF', 'SHY', 'HYG'])

export const tiers = {
  realistic: { etf: 1, otherEtf: 2, stock: 3 },
  base: { etf: 2, otherEtf: 2, stock: 5 },
  harsh: { etf: 5, otherEtf: 5, stock: 10 },
  brutal: { etf: 10, otherEtf: 10, stock: 15 },
}
export type Tier = (typeof tiers)[keyof typeof tiers]
export const frictionBps = (symbol: string, tier: Tier) =>
  !etfSymbols.has(symbol) ? tier.stock : hyperLiquid.has(symbol) ? tier.etf : tier.otherEtf
export type CashMode = 'zero' | 'shy'
export type EquityMode = 'fixed' | 'compounded'
type Mark = (symbol: string, date: string, phase: 'open' | 'close') => number | undefined
export interface Sleeve {
  readonly weight: number
  readonly mark: Mark
  // Undefined holds existing shares; an empty map is an explicit exit.
  readonly open: (date: string) => { unit: 'shares' | 'dollars'; positions: Plan; partial?: boolean } | undefined
  readonly closeExit?: (symbol: string, date: string) => boolean
}
export interface Execution {
  readonly net: number
  readonly peakGross: number
  readonly scaled: boolean
  readonly grossCapHit: boolean
  readonly dtbpHit: boolean
  readonly trades: number
  readonly missing: number
}
export type Intraday = (day: {
  date: string
  budget: number
  capacity: number
  overnightGross: number
  dtbp: number
  overnightSymbols: ReadonlySet<string>
  tier: Tier
}) => Execution
export const noIntraday: Execution = {
  net: 0,
  peakGross: 0,
  scaled: false,
  grossCapHit: false,
  dtbpHit: false,
  trades: 0,
  missing: 0,
}
type Market = { date: string; shy: number; spy: number; ief: number }
export type Daily = ReturnType<ReturnType<typeof createAccount>>

export function createAccount(input: {
  readonly overnight: readonly Sleeve[]
  readonly intraday?: Intraday
  readonly weight: number
  readonly tier: Tier
  readonly cash: CashMode
  readonly equity: EquityMode
}) {
  let equity = capital
  let previousGross = 0
  let previousLong = 0
  let previousShort = 0
  let previousMaintenance = 0
  let previousDate: string | undefined
  const books = input.overnight.map(() => new Map<string, { shares: number; price: number }>())
  return ({ date, shy, spy, ief }: Market) => {
    if (equity <= 0 || !Number.isFinite(equity)) throw new Error(`Invalid account equity entering ${date}: ${equity}`)
    const startEquity = equity
    // Fixed requests are $100k-based, but accumulated losses still constrain actual account buying power.
    const sizingEquity = input.equity === 'fixed' ? capital : startEquity
    const riskEquity = Math.min(sizingEquity, startEquity)
    const nights = previousDate === undefined ? 0 : (Date.parse(date) - Date.parse(previousDate)) / dayMs
    if (previousDate !== undefined && !(nights > 0)) throw new Error(`Invalid account calendar: ${date}`)
    let overnightPnl = 0
    let traded = 0
    let costs = 0
    let sellFees = 0
    const borrow = (previousShort * borrowRate * nights) / 365
    const debit = (Math.max(0, previousLong - riskEquity) * debitRate * nights) / 360
    // Restricted short-sale proceeds and collateral do not earn the proxy.
    const idleCash = Math.max(0, riskEquity - previousGross)
    const carry = input.cash === 'shy' ? idleCash * shy : 0
    const trade = (symbol: string, amount: number) => {
      traded += Math.abs(amount)
      costs += (Math.abs(amount) * frictionBps(symbol, input.tier)) / 20_000
      sellFees += Math.max(0, -amount) * sellFee
    }
    const mark = (sleeve: Sleeve, symbol: string, phase: 'open' | 'close') => {
      const px = sleeve.mark(symbol, date, phase)
      if (px === undefined || !Number.isFinite(px) || px <= 0)
        throw new Error(`Missing ${symbol} ${phase} price on ${date}`)
      return px
    }

    let openGapGross = 0
    let overnightTrim = false
    const rebalance = (phase: 'open' | 'close', cap: number) => {
      const targets = input.overnight.map((sleeve, slot) => {
        const book = books[slot]
        const request = phase === 'open' ? sleeve.open(date) : undefined
        const symbols = new Set([...book.keys(), ...(request?.positions.keys() ?? [])])
        return [...symbols].map((symbol) => {
          const px = mark(sleeve, symbol, phase)
          const position = book.get(symbol)
          const old = position?.shares ?? 0
          if (position !== undefined) {
            overnightPnl += old * (px - position.price)
            if (phase === 'open') openGapGross += Math.abs(old * px)
          }
          const requested = request?.positions.get(symbol) ?? 0
          const next =
            request !== undefined && (request.partial !== true || request.positions.has(symbol))
              ? (request.unit === 'dollars' ? requested / px : requested) * sizingEquity * sleeve.weight
              : phase === 'close' && sleeve.closeExit?.(symbol, date) === true
                ? 0
                : old
          return { symbol, px, old, next }
        })
      })
      const gross = targets.flat().reduce((total, { next, px }) => total + Math.abs(next * px), 0)
      const margin = targets
        .flat()
        .reduce((total, { next, px }) => total + Math.max(Math.abs(next) * px * 0.5, maintenanceFor(next, px)), 0)
      const factor = Math.min(gross > cap ? cap / gross : 1, margin > riskEquity ? riskEquity / margin : 1)
      overnightTrim ||= factor < 1
      let long = 0
      let short = 0
      let maintenance = 0
      targets.forEach((target, slot) => {
        const book = books[slot]
        for (const { symbol, px, old, next } of target) {
          const shares = next * factor
          const notional = shares * px
          trade(symbol, (shares - old) * px)
          if (shares === 0) book.delete(symbol)
          else book.set(symbol, { shares, price: px })
          long += Math.max(0, notional)
          short += Math.max(0, -notional)
          maintenance += maintenanceFor(shares, px)
        }
      })
      return { long, short, gross: long + short, maintenance }
    }
    const overnightCap = Math.min(overnightLimit, 2 * riskEquity)
    const open = rebalance('open', overnightCap)
    // Previous-close maintenance drives today’s DTBP; exits do not reset it.
    const dtbp = riskEquity >= 25_000 ? 4 * Math.max(0, riskEquity - previousMaintenance) : 0
    const capacity = Math.min(Math.max(0, intradayLimit - open.gross), dtbp)
    const intraday =
      input.intraday?.({
        date,
        budget: input.weight * sizingEquity,
        capacity,
        overnightGross: open.gross,
        dtbp,
        overnightSymbols: new Set(books.flatMap((book) => [...book.keys()])),
        tier: input.tier,
      }) ?? noIntraday
    if (!(intraday.peakGross >= 0 && intraday.peakGross <= capacity + 1e-8))
      throw new Error(`Intraday ledger exceeded capacity on ${date}`)
    // Price-driven breaches are observable at the mark, not preventable by pre-trade caps.
    const closing = rebalance('close', overnightCap)
    previousGross = closing.gross
    previousLong = closing.long
    previousShort = closing.short
    previousMaintenance = closing.maintenance
    previousDate = date

    const overnightNet = overnightPnl - costs - sellFees - borrow - debit
    const net = overnightNet + intraday.net + carry
    equity += net
    return {
      date,
      spy,
      shy,
      sixtyForty: 0.6 * spy + 0.4 * ief,
      net,
      startEquity,
      equity,
      overnightNet,
      intradayNet: intraday.net,
      overnightGross: open.gross,
      closeGross: closing.gross,
      gapGross: openGapGross,
      peakCombined: open.gross + intraday.peakGross,
      overnightTrim,
      intraday,
      traded,
      costs,
      sellFees,
      borrow,
      debit,
      carry,
      idleCash,
    }
  }
}

export function maintenanceFor(shares: number, price: number) {
  if (shares < 0) return -shares * (price < 5 ? Math.max(2.5, price) : Math.max(5, 0.3 * price))
  return shares * price * (price < 2.5 ? 1 : price <= 6 ? 0.5 : 0.3)
}

export function reservationScale(requested: number, held: number, capacity: number) {
  return requested <= 0 ? 1 : Math.min(1, Math.max(0, capacity - held) / requested)
}
