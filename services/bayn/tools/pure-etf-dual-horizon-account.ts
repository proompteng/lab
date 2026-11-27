import { borrow, etfs as canaryEtfs, mix, sellFee } from './etf-canary-macro-protocol'
import { executionRule } from './etf-canary-macro-signals'
import { etfs as premiaEtfs } from './multi-asset-risk-premia-protocol'
import { elapsedDays, etfs, type DailyFrame } from './pure-etf-dual-horizon-data'
import { noiseRosters, type NoiseId, type NoiseOrder } from './pure-etf-dual-horizon-noise'

export const initialEquity = 100_000
export const costs = [1, 2, 5, 10] as const
export const modes = ['fixed', 'compound'] as const
export const carries = ['SHY', 'zero'] as const
export type Mode = (typeof modes)[number]
export type Carry = (typeof carries)[number]
export type Cost = (typeof costs)[number]
export type Mix = { O1: number; O2: number; noise?: NoiseId; intraday: number }
export const mixes = {
  M1: { O1: 1, O2: 0, intraday: 0 },
  M2: { O1: 0, O2: 0, noise: 'I1', intraday: 1 },
  M3: { O1: 0, O2: 0, noise: 'I2', intraday: 1 },
  M4: { O1: 1, O2: 0, noise: 'I1', intraday: 0.5 },
  M5: { O1: 1, O2: 0, noise: 'I1', intraday: 1 },
  M6: { O1: 0.5, O2: 0.5, noise: 'I2', intraday: 0.5 },
} as const satisfies Record<string, Mix>

const overnightUsd = 150_000
const intradayUsd = 180_000
const epsilon = 1e-8
const weightEpsilon = 1e-12
const rate = 0.065
const halfSpread = (bp: Cost) => bp / 20_000
const worstEntryMultiplier = 1 + halfSpread(10)
const canaryIndex = etfs.map((symbol) => canaryEtfs.findIndex((name) => name === symbol))
const premiaIndex = etfs.map((symbol) => premiaEtfs.findIndex((name) => name === symbol))
const shy = etfs.indexOf('SHY')
const flat = () => new Float64Array(etfs.length)
const gross = (values: Float64Array) => values.reduce((sum, v) => sum + Math.abs(v), 0)

type Positions = { o1: Float64Array; o2: Float64Array; shy: number }
const empty = (): Positions => ({ o1: flat(), o2: flat(), shy: 0 })
const net = (p: Positions) => p.o1.map((v, i) => v + p.o2[i] + (i === shy ? p.shy : 0))
const scale = ({ o1, o2, shy }: Positions, fraction: number): Positions => ({
  o1: o1.map((v) => v * fraction),
  o2: o2.map((v) => v * fraction),
  shy: shy * fraction,
})
const notionals = (p: Float64Array) =>
  p.reduce(
    ({ longs, shorts }, v) => ({
      longs: longs + Math.max(0, v),
      shorts: shorts - Math.min(0, v),
    }),
    { longs: 0, shorts: 0 },
  )
const barPrice = (frame: DailyFrame, symbol: string, mark: 'open' | 'close') => {
  const p = frame.bars.get(symbol)?.[mark]
  if (p === undefined || !Number.isFinite(p) || p <= 0)
    throw new Error(`Unmarkable position: ${frame.date} ${symbol} ${mark}`)
  return p
}
const mark = (p: Positions, ratio: (symbol: string) => number): Positions => ({
  o1: p.o1.map((v, i) => (v === 0 ? 0 : v * ratio(etfs[i]))),
  o2: p.o2.map((v, i) => (v === 0 ? 0 : v * ratio(etfs[i]))),
  shy: p.shy === 0 ? 0 : p.shy * ratio('SHY'),
})
const difference = (to: Float64Array, from: Float64Array) => to.reduce((sum, v, i) => sum + v - from[i], 0)
const economics = (from: Float64Array, to: Float64Array, bp: Cost) => {
  const orders = from.map((v, i) => to[i] - v)
  return {
    turnover: gross(orders),
    slippage: gross(orders) * halfSpread(bp),
    fee: orders.reduce((fees, v) => fees - sellFee * Math.min(0, v), 0),
  }
}
const cost = (trade: ReturnType<typeof economics>) => trade.slippage + trade.fee

const funding = (equity: number, positions: Float64Array, days: number) => {
  const { longs, shorts } = notionals(positions)
  return {
    borrow: (shorts * borrow * days) / 365,
    // Short-sale proceeds cannot finance long inventory.
    debit: (Math.max(0, longs - equity) * rate * days) / 360,
  }
}

export const buyingPower = (lastEquity: number, maintenanceMargin: number) =>
  lastEquity < 25_000 ? 0 : Math.max(0, 4 * (lastEquity - maintenanceMargin))

const maintenance = (last: DailyFrame, positions: Float64Array, equity: number) => {
  const { longs } = notionals(positions)
  return positions.reduce((total, v, i) => {
    if (v === 0) return total
    const price = barPrice(last, etfs[i], 'close')
    if (v < 0) return total - v * (price < 5 ? Math.max(1, 2.5 / price) : Math.max(0.3, 5 / price))
    const concentrated = longs - equity >= 100_000 && v >= 0.7 * longs
    return total + v * (price < 2.5 ? 1 : price <= 6 || concentrated ? 0.5 : 0.3)
  }, 0)
}

export const tradeNoise = (
  date: string,
  orders: readonly NoiseOrder[],
  strategy: NoiseId | undefined,
  weight: number,
  riskEquity: number,
  capacity: number,
  occupied: ReadonlySet<string>,
  bp: Cost,
) => {
  const trades: {
    symbol: string
    signedShares: number
    entrySlot: number
    exitSlot: number
    entry: number
    exit: number
    returned: number
    pnl: number
    slippage: number
    fee: number
    heldGaps: number
    exitSource?: NoiseOrder['exitSource']
  }[] = []
  let missingEntries = 0
  let conflicts = 0
  let trims = 0
  let peakReserved = 0
  if (strategy === undefined) return { trades, missingEntries, conflicts, trims, peakReserved }
  const roster = new Set<string>(noiseRosters[strategy])
  const active: { reserved: number; exitSlot: number }[] = []
  const sizing = (riskEquity / initialEquity) * weight
  const cap = 60_000 * sizing
  for (const order of orders) {
    if (!roster.has(order.symbol)) continue
    const { symbol, entrySlot, exitSlot, entry, exit, reference, atr, side } = order
    if (occupied.has(symbol)) {
      conflicts++
      continue
    }
    if (entry === undefined) {
      missingEntries++
      continue
    }
    const existing = active.reduce((total, leg) => total + (leg.exitSlot > entrySlot ? leg.reserved : 0), 0)
    const perShare = entry * worstEntryMultiplier
    const requested = Math.floor(Math.min(cap / reference, (1_500 * sizing) / (roster.size * atr), cap / perShare))
    const shares = Math.min(requested, Math.floor(Math.max(0, capacity - existing) / perShare))
    if (shares < requested) trims++
    if (shares === 0) continue
    if (exit === undefined) throw new Error(`Unresolved intraday exit: ${date} ${symbol} at slot ${exitSlot}`)
    const reserved = shares * perShare
    active.push({ reserved, exitSlot })
    peakReserved = Math.max(peakReserved, existing + reserved)
    const pnl = side * shares * (exit - entry)
    const slippage = shares * (entry + exit) * halfSpread(bp)
    const fee = shares * (side === 1 ? exit : entry) * (1 - halfSpread(bp)) * sellFee
    trades.push({
      symbol,
      signedShares: shares * side,
      entrySlot,
      exitSlot,
      entry,
      exit,
      returned: pnl - slippage - fee,
      pnl,
      slippage,
      fee,
      heldGaps: order.heldGaps,
      ...(order.exitSource === undefined ? {} : { exitSource: order.exitSource }),
    })
  }
  return { trades, missingEntries, conflicts, trims, peakReserved }
}

type Targets = { O1: readonly Float64Array[]; O2: readonly (readonly number[])[] }
type LedgerOptions = { mix: Mix; mode: Mode; carry: Carry; bp: Cost }

export const replayAccount = (
  daily: readonly DailyFrame[],
  noise: readonly (readonly NoiseOrder[])[],
  targets: Targets,
  options: LedgerOptions,
) => {
  const { mix: allocation, mode, carry, bp } = options
  let positions = empty()
  let equity = initialEquity
  let previousMaintenance = 0
  // Both gross limits depend on actual equity. Fixed notional does not reinvest P&L in target sizing.
  const risk = (nav: number) => (mode === 'fixed' ? initialEquity : nav)
  const overnightLimit = (nav: number) => Math.min(overnightUsd, 2 * risk(nav), 2 * nav)

  return daily.map((day, i) => {
    const before = equity
    const last = daily[i - 1]
    const prior = positions
    const priorNet = net(prior)
    const overnightFinancing = funding(before, priorNet, last === undefined ? 0 : elapsedDays(last.date, day.date))
    const opened =
      last === undefined
        ? prior
        : mark(prior, (symbol) => barPrice(day, symbol, 'open') / barPrice(last, symbol, 'close'))
    const openedNet = net(opened)
    const o1Gap = difference(opened.o1, prior.o1)
    const o2Gap = difference(opened.o2, prior.o2)
    const shyGap = opened.shy - prior.shy
    const openEquity = before + o1Gap + o2Gap + shyGap - overnightFinancing.borrow - overnightFinancing.debit
    if (!(openEquity > 0)) throw new Error(`Nonpositive opening equity: ${day.date}`)

    const previousIndex = i - 1
    const o1Target = targets.O1[previousIndex]
    const o2Target = targets.O2[previousIndex]
    const o2Previous = targets.O2[previousIndex - 1]
    const { review, band } = executionRule(mix, previousIndex)
    const changedO1 = canaryIndex.map((j, k) => {
      if (allocation.O1 === 0 || !review || j < 0) return false
      const drift = Math.abs(o1Target[j] - prior.o1[k] / (risk(before) * allocation.O1))
      return drift > weightEpsilon && drift >= band
    })
    const changedO2 = premiaIndex.map(
      (j) => allocation.O2 > 0 && j >= 0 && Math.abs((o2Target?.[j] ?? 0) - (o2Previous?.[j] ?? 0)) > weightEpsilon,
    )
    const rebalance = changedO1.some(Boolean) || changedO2.some(Boolean)
    const sizeOpening = (nav: number) => {
      const keptO1 = opened.o1.reduce((sum, v, k) => sum + (changedO1[k] ? 0 : Math.abs(v)), 0)
      const plannedO1 = changedO1.reduce(
        (sum, changed, k) => sum + (changed ? Math.abs(o1Target[canaryIndex[k]]) : 0),
        0,
      )
      const budget = risk(nav) * allocation.O1
      const scaleO1 = plannedO1 === 0 ? 0 : Math.min(budget, Math.max(0, budget - keptO1) / plannedO1)
      const o1 = opened.o1.map((v, k) => (changedO1[k] ? o1Target[canaryIndex[k]] * scaleO1 : v))
      const o2 = opened.o2.map((v, k) => (changedO2[k] ? o2Target[premiaIndex[k]] * risk(nav) * allocation.O2 : v))
      const available = Math.max(0, Math.min(nav, risk(nav)) - gross(o1.map((v, k) => v + o2[k])))
      const sweep = carry === 'SHY' ? (rebalance || i === 0 ? available : Math.min(available, opened.shy)) : 0
      const desired = { o1, o2, shy: sweep }
      const exposure = gross(net(desired))
      const limit = overnightLimit(nav)
      return { positions: exposure > limit ? scale(desired, limit / exposure) : desired, trim: exposure > limit }
    }
    const settle = (
      from: Float64Array,
      nav: number,
      size: (afterFees: number) => { positions: Positions; trim: boolean },
    ) => {
      let next = nav
      for (let attempt = 0; attempt < 16; attempt++) {
        const sized = size(next)
        const trade = economics(from, net(sized.positions), bp)
        const after = nav - cost(trade)
        if (!(after > 0)) break
        if (Math.abs(next - after) < epsilon) return { ...sized, trade, equity: after }
        next = after
      }
      throw new Error(`Cannot fund rebalance at ${day.date}`)
    }
    const opening = settle(openedNet, openEquity, sizeOpening)
    const openNet = net(opening.positions)
    const grossOpen = gross(openNet)
    const occupied = new Set(etfs.filter((_, k) => Math.abs(openNet[k]) > epsilon))
    const dtbp = buyingPower(before, previousMaintenance)
    const capacity = Math.max(0, Math.min(dtbp, intradayUsd - grossOpen))
    const overlay = tradeNoise(
      day.date,
      noise[i] ?? [],
      allocation.noise,
      allocation.intraday,
      risk(opening.equity),
      capacity,
      occupied,
      bp,
    )
    // The overnight book is reserved at the daily open, not marked along an unobserved synchronized quote path.
    const closing = mark(opening.positions, (symbol) => barPrice(day, symbol, 'close') / barPrice(day, symbol, 'open'))
    const closingNet = net(closing)
    const o1Pnl = o1Gap + difference(closing.o1, opening.positions.o1)
    const o2Pnl = o2Gap + difference(closing.o2, opening.positions.o2)
    const shyPnl = shyGap + closing.shy - opening.positions.shy
    const noisePnl = overlay.trades.reduce((sum, leg) => sum + leg.pnl, 0)
    const intradaySlippage = overlay.trades.reduce((sum, leg) => sum + leg.slippage, 0)
    const intradayFee = overlay.trades.reduce((sum, leg) => sum + leg.fee, 0)
    const closeBeforeFees =
      opening.equity + o1Pnl - o1Gap + o2Pnl - o2Gap + shyPnl - shyGap + noisePnl - intradaySlippage - intradayFee
    const close = settle(closingNet, closeBeforeFees, (nav) => {
      // Intraday-only books sweep deployable cash overnight; mixed books sweep at their strategy rebalance.
      const wanted =
        carry === 'SHY' && allocation.O1 === 0 && allocation.O2 === 0
          ? { ...closing, shy: Math.min(risk(nav), nav) }
          : closing
      const exposure = gross(net(wanted))
      const limit = overnightLimit(nav)
      return { positions: exposure > limit ? scale(wanted, limit / exposure) : wanted, trim: exposure > limit }
    })
    equity = close.equity
    positions = close.positions
    const closeNet = net(positions)
    previousMaintenance = maintenance(day, closeNet, equity)
    if (
      grossOpen > overnightLimit(opening.equity) + epsilon ||
      gross(closeNet) > overnightLimit(equity) + epsilon ||
      overlay.peakReserved > capacity + epsilon ||
      overlay.trades.some((leg) => occupied.has(leg.symbol))
    ) {
      throw new Error(`Exposure invariant failed on ${day.date}`)
    }
    const slippage = opening.trade.slippage + close.trade.slippage + intradaySlippage
    const fee = opening.trade.fee + close.trade.fee + intradayFee
    const pnl = equity - before
    const reconciled =
      o1Pnl + o2Pnl + shyPnl + noisePnl - slippage - fee - overnightFinancing.borrow - overnightFinancing.debit
    if (Math.abs(pnl - reconciled) > epsilon) throw new Error(`P&L does not reconcile on ${day.date}`)
    return {
      date: day.date,
      equity,
      pnl,
      return: pnl / (mode === 'fixed' ? initialEquity : before),
      o1Pnl,
      o2Pnl,
      shyPnl,
      noisePnl,
      slippage,
      fee,
      ...overnightFinancing,
      overnightTurnover: opening.trade.turnover + close.trade.turnover,
      openGross: grossOpen,
      closeGross: gross(closeNet),
      overnightLimit: overnightLimit(equity),
      dtbp,
      capacity,
      intradayPeak: overlay.peakReserved,
      overnightTrim: opening.trim || close.trim,
      missingEntries: overlay.missingEntries,
      conflicts: overlay.conflicts,
      intradayTrims: overlay.trims,
      overnightClose: Object.fromEntries(
        etfs.flatMap((symbol, k) => (closeNet[k] === 0 ? [] : [[symbol, closeNet[k]]])),
      ),
      openPositions: {
        O1: Array.from(opening.positions.o1),
        O2: Array.from(opening.positions.o2),
        SHY: opening.positions.shy,
      },
      trades: overlay.trades,
    }
  })
}
export type LedgerRow = ReturnType<typeof replayAccount>[number]
