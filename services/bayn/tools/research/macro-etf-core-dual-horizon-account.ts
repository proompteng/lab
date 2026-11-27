import { wholeShareCost, rebalanceDue, withShyCarry } from '../../src/strategy/macro-etf-core/planner'
import { asset, universe } from '../../src/strategy/macro-etf-core/policy'
import { elapsedDays } from '../pure-etf-dual-horizon-data'
import { type NoiseOrder, noiseRosters } from '../pure-etf-dual-horizon-noise'
import type { DailyFrame } from './macro-etf-core-dual-horizon-data'
import { o1Band } from './macro-etf-core-wave5d'

export const initialUsd = 100_000
export const costs = [2, 5, 10] as const
const micros = (usd: number) => BigInt(Math.round(usd * 1_000_000))
const dollars = (amount: bigint) => Number(amount) / 1_000_000
const initial = micros(initialUsd)
const overnightCap = micros(150_000)
const combinedCap = micros(180_000)
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const max = (a: bigint, b: bigint) => (a > b ? a : b)
const abs = (n: bigint) => (n >= 0n ? n : -n)
const ceiling = (n: bigint, d: bigint) => (n + d - 1n) / d
const book = () => universe.map(() => 0n)
const shy = asset.SHY

type Mix = { readonly f2: number; readonly f4: number; readonly o1: number; readonly noise: number }
export const mixes = {
  E1: { f2: 1, f4: 0, o1: 0, noise: 0 },
  E2: { f2: 0, f4: 1, o1: 0, noise: 0 },
  I1: { f2: 0, f4: 0, o1: 0, noise: 1 },
  P1: { f2: 0, f4: 1, o1: 0, noise: 1 },
  P2: { f2: 1, f4: 0, o1: 0, noise: 1 },
  P3: { f2: 0.5, f4: 0.5, o1: 0, noise: 1 },
  P4: { f2: 0, f4: 0.5, o1: 0.5, noise: 1 },
} as const satisfies Record<string, Mix>

type Shares = { macro: bigint[]; o1: bigint[]; o1Carry: bigint }
const flat = (): Shares => ({ macro: book(), o1: book(), o1Carry: 0n })
const net = ({ macro, o1, o1Carry }: Shares) => macro.map((q, i) => q + o1[i] + (i === shy ? o1Carry : 0n))
type Frame = ReturnType<typeof toMarks>[number]
export const toMarks = (daily: readonly DailyFrame[]) =>
  daily.map(({ date, bars }) => ({
    date,
    open: universe.map((symbol) => {
      const bar = bars.get(symbol)
      return bar === undefined ? undefined : micros(bar.open)
    }),
    close: universe.map((symbol) => {
      const bar = bars.get(symbol)
      return bar === undefined ? undefined : micros(bar.close)
    }),
  }))

type Marks = Frame['open']
const required = (marks: Marks, i: number, date: string) => {
  const price = marks[i]
  if (price === undefined || price <= 0n) throw new Error(`Missing execution mark: ${universe[i]} ${date}`)
  return price
}
const values = (positions: readonly bigint[], marks: Marks, date: string) =>
  positions.map((qty, i) => (qty === 0n ? 0n : qty * required(marks, i, date)))
const total = (values: readonly bigint[]) => values.reduce((sum, v) => sum + v, 0n)
const markGross = (positions: readonly bigint[], marks: Marks, date: string) => total(values(positions, marks, date))

// Preregistered Alpaca long price tiers; funds in the frozen roster are not leveraged ETFs.
const longMaintenance = (price: bigint, concentrated: boolean) =>
  price < micros(2.5) ? 10_000n : price <= micros(6) || concentrated ? 5_000n : 3_000n
const maintenance = (positions: readonly bigint[], closing: Marks, gross: bigint, equity: bigint, date: string) =>
  ceiling(
    positions.reduce((sum, q, i) => {
      if (q === 0n) return sum
      const price = required(closing, i, date)
      const v = q * price
      const concentrated = gross - equity >= micros(100_000) && v * 10n >= gross * 7n
      return sum + longMaintenance(price, concentrated) * v
    }, 0n),
    10_000n,
  )
const buyingPower = (equity: bigint, requirement: bigint) =>
  equity < micros(25_000) ? 0n : 4n * max(0n, equity - requirement)
const overnightLimit = (equity: bigint) => min(overnightCap, (equity < micros(2_000) ? 1n : 2n) * equity)

const tradeNet = (from: readonly bigint[], to: readonly bigint[], mark: Marks, date: string, bp: number) => {
  let cashDelta = 0n
  let fees = 0n
  let traded = 0n
  for (const side of ['sell', 'buy'] as const) {
    for (const [i, q] of to.entries()) {
      const delta = q - from[i]
      if (side === 'sell' ? delta >= 0n : delta <= 0n) continue
      const notional = abs(delta) * required(mark, i, date)
      const cost = wholeShareCost(notional, side, bp)
      cashDelta -= delta > 0n ? notional + cost : cost - notional
      fees += cost
      traded += notional
    }
  }
  return { cashDelta, fees, traded }
}

const scaleBook = (positions: Shares, budget: bigint, gross: bigint): Shares =>
  gross <= budget
    ? positions
    : {
        macro: positions.macro.map((q) => (q * budget) / gross),
        o1: positions.o1.map((q) => (q * budget) / gross),
        o1Carry: (positions.o1Carry * budget) / gross,
      }

const settle = (
  from: Shares,
  cash: bigint,
  mark: Marks,
  date: string,
  bp: number,
  size: (riskBudget: bigint) => Shares,
  fullyFunded: boolean,
) => {
  const initialShares = net(from)
  const nav = cash + markGross(initialShares, mark, date)
  let after = nav
  // Only lower the sizing budget: discrete whole shares need not have an exact fixed point.
  for (let attempt = 0; attempt < 16 && after > 0n; attempt++) {
    const limit = min(overnightLimit(after), fullyFunded ? after : overnightCap)
    const desired = size(min(after, overnightCap))
    const positions = scaleBook(desired, limit, markGross(net(desired), mark, date))
    const final = net(positions)
    const gross = markGross(final, mark, date)
    const trade = tradeNet(initialShares, final, mark, date, bp)
    const equity = nav - trade.fees
    const updatedCash = cash + trade.cashDelta
    if (equity !== updatedCash + gross) throw new Error(`Overnight ledger mismatch: ${date}`)
    if (
      equity > 0n &&
      gross <= overnightLimit(equity) &&
      (!fullyFunded || updatedCash >= 0n) &&
      maintenance(final, mark, gross, equity, date) <= equity
    ) {
      if (!fullyFunded || trade.fees === 0n || after <= equity)
        return { positions, cash: updatedCash, gross, equity, trade, trimmed: positions !== desired }
    }
    after = min(after - 1n, equity)
  }
  throw new Error(`Unable to settle marked account: ${date}`)
}

const quantity = (weight: number, budget: bigint, mark: Marks, i: number, date: string) =>
  weight === 0 || budget === 0n ? 0n : BigInt(Math.floor(weight * Number(budget))) / required(mark, i, date)

export const tradeNoise = (
  date: string,
  orders: readonly NoiseOrder[],
  weight: number,
  riskEquity: bigint,
  capacity: bigint,
  occupied: readonly bigint[],
  bp: number,
) => {
  const sizing = (dollars(riskEquity) / initialUsd) * weight
  const cap = 60_000 * sizing
  const active: { reserved: bigint; exitSlot: number }[] = []
  let netPnl = 0n
  let traded = 0n
  let peak = 0n
  let conflicts = 0
  let missingEntries = 0
  let trims = 0
  let fills = 0
  let heldGaps = 0
  if (weight > 0)
    for (const order of orders) {
      const { symbol, entrySlot, exitSlot, entry, exit, reference, atr, side } = order
      if (symbol !== 'QQQ' && symbol !== 'SMH') throw new Error(`Non-C5 Noise order: ${symbol} ${date}`)
      if (occupied[asset[symbol]] > 0n) {
        conflicts++
        continue
      }
      if (entry === undefined) {
        missingEntries++
        continue
      }
      const existing = total(active.filter((position) => position.exitSlot > entrySlot).map(({ reserved }) => reserved))
      const entryPrice = micros(entry)
      if (entryPrice <= 0n) throw new Error(`Invalid Noise entry: ${symbol} ${date}`)
      // Reserve at the worst registered one-way cost. The original C5 identity check uses its own 5 bp reserve.
      const perShare = entryPrice + ceiling(entryPrice * BigInt(bp === 1 ? 5 : 10), 10_000n)
      const wanted = BigInt(
        Math.floor(
          Math.min(cap / reference, (1_500 * sizing) / (noiseRosters.I1.length * atr), cap / dollars(perShare)),
        ),
      )
      const shares = min(wanted, max(0n, capacity - existing) / perShare)
      if (shares < wanted) trims++
      if (shares === 0n) continue
      if (exit === undefined) throw new Error(`Unresolved Noise exit: ${symbol} ${date} slot ${exitSlot}`)
      const exitPrice = micros(exit)
      if (exitPrice <= 0n) throw new Error(`Invalid Noise exit: ${symbol} ${date}`)
      const reserved = shares * perShare
      active.push({ reserved, exitSlot })
      peak = max(peak, existing + reserved)
      const entryValue = shares * entryPrice
      const exitValue = shares * exitPrice
      netPnl +=
        BigInt(side) * (exitValue - entryValue) -
        wholeShareCost(entryValue, side === 1 ? 'buy' : 'sell', bp) -
        wholeShareCost(exitValue, side === 1 ? 'sell' : 'buy', bp)
      traded += entryValue + exitValue
      fills++
      heldGaps += order.heldGaps
    }
  return { netPnl, traded, peak, conflicts, missingEntries, trims, fills, heldGaps }
}

type Targets = {
  F2: ReadonlyMap<string, readonly number[]>
  F4: ReadonlyMap<string, readonly number[]>
  O1: readonly (readonly number[] | undefined)[]
}

export const replayAccount = (
  marks: readonly Frame[],
  noise: readonly (readonly NoiseOrder[])[],
  target: Targets,
  mix: Mix,
  bp: number,
) => {
  let positions = flat()
  let cash = initial
  let equity = initial
  let requirement = 0n
  const macroWeight = mix.f2 + mix.f4
  const standaloneNoise = macroWeight + mix.o1 === 0
  const sleeveBudget = (nav: bigint, fraction: number) => BigInt(Math.floor(Number(nav) * fraction))

  return marks.map(({ date, open, close }, i) => {
    const before = equity
    const prior = marks[i - 1]
    const priorNet = net(positions)
    const priorGross = before - cash
    const elapsed = prior === undefined ? 0 : elapsedDays(prior.date, date)
    const financing = ceiling(max(0n, -cash) * 65n * BigInt(elapsed), 360_000n)
    cash -= financing
    const priorMacro = prior === undefined ? book() : values(positions.macro, prior.close, prior.date)
    const priorO1 = prior === undefined ? book() : values(positions.o1, prior.close, prior.date)
    const f2 = target.F2.get(date)
    const f4 = target.F4.get(date)
    if ((f2 === undefined) !== (f4 === undefined)) throw new Error(`Wave 5C cadence mismatch: ${date}`)
    const macro =
      f2 !== undefined && f4 !== undefined && macroWeight > 0
        ? withShyCarry(f2.map((v, j) => (v * mix.f2 + f4[j] * mix.f4) / macroWeight))
        : undefined
    const priorMacroBudget = sleeveBudget(before, macroWeight)
    const reviewMacro =
      macro !== undefined &&
      rebalanceDue(
        macro.map((weight, j) => ({ weight, priorMicros: priorMacro[j] })),
        priorMacroBudget,
      )
    const o1 = mix.o1 === 0 ? undefined : target.O1[i - 1]
    const o1Budget = sleeveBudget(before, mix.o1)
    const changedO1 = universe.map(
      (_, j) => o1 !== undefined && Math.abs(o1[j] - Number(priorO1[j]) / Number(o1Budget)) >= o1Band,
    )
    const reviewO1 = changedO1.some(Boolean)
    const opening = settle(
      positions,
      cash,
      open,
      date,
      bp,
      (budget) => {
        if (i === 0) {
          const q = required(open, shy, date)
          const next = flat()
          next.macro[shy] = sleeveBudget(budget, standaloneNoise ? 1 : macroWeight) / q
          next.o1Carry = sleeveBudget(budget, mix.o1) / q
          return next
        }
        const vested = positions.o1.map((q, j) => (changedO1[j] ? 0n : q))
        const kept = markGross(vested, open, date)
        // If O1 is also reviewing, reserve only its untouched positions here. Its
        // subsequent complete target is bounded by both its half and remaining room.
        const reservedO1 = reviewO1 ? kept : kept + positions.o1Carry * required(open, shy, date)
        const macroBudget = min(sleeveBudget(budget, macroWeight), max(0n, budget - reservedO1))
        const macroShares =
          reviewMacro && macro !== undefined
            ? macro.map((w, j) => quantity(w, macroBudget, open, j, date))
            : positions.macro
        if (o1 === undefined || !reviewO1) return { ...positions, macro: macroShares }
        const planned = o1.reduce((sum, w, j) => (changedO1[j] ? sum + w : sum), 0)
        const entitlement = min(sleeveBudget(budget, mix.o1), max(0n, budget - markGross(macroShares, open, date)))
        const remaining = max(0n, entitlement - kept)
        const scale = planned === 0 ? 0n : min(entitlement, BigInt(Math.floor(Number(remaining) / planned)))
        const nextO1 = o1.map((w, j) => (changedO1[j] ? quantity(w, scale, open, j, date) : vested[j]))
        const available = max(0n, entitlement - markGross(nextO1, open, date))
        return { macro: macroShares, o1: nextO1, o1Carry: available / required(open, shy, date) }
      },
      i === 0 || reviewMacro || reviewO1,
    )
    const openNet = net(opening.positions)
    const dtbp = buyingPower(before, requirement)
    const capacity = max(0n, min(dtbp, combinedCap - opening.gross))
    const overlay = tradeNoise(date, noise[i], mix.noise, opening.equity, capacity, openNet, bp)
    const closing = settle(
      opening.positions,
      opening.cash + overlay.netPnl,
      close,
      date,
      bp,
      (budget) => {
        if (!standaloneNoise) return opening.positions
        const next = flat()
        next.macro[shy] = budget / required(close, shy, date)
        return next
      },
      standaloneNoise,
    )
    cash = closing.cash
    equity = closing.equity
    positions = closing.positions
    requirement = maintenance(net(positions), close, closing.gross, equity, date)
    const macroPnl =
      markGross(priorNet, open, date) -
      priorGross +
      markGross(openNet, close, date) -
      opening.gross -
      financing -
      opening.trade.fees -
      closing.trade.fees
    if (
      equity - before !== macroPnl + overlay.netPnl ||
      overlay.peak > capacity ||
      opening.gross + overlay.peak > combinedCap
    )
      throw new Error(`Daily P&L or capacity invariant failed: ${date}`)
    return {
      date,
      equity: dollars(equity),
      net: Number(equity - before) / Number(before),
      overnight: Number(macroPnl) / Number(before),
      intraday: Number(overlay.netPnl) / Number(before),
      overnightTraded: dollars(opening.trade.traded + closing.trade.traded),
      intradayTraded: dollars(overlay.traded),
      oneWayTurnover: Number(opening.trade.traded + closing.trade.traded + overlay.traded) / (2 * Number(before)),
      overnightOneWayTurnover: Number(opening.trade.traded + closing.trade.traded) / (2 * Number(before)),
      openGross: dollars(opening.gross),
      closeGross: dollars(closing.gross),
      reserved: dollars(overlay.peak),
      dtbp: dollars(dtbp),
      overnightTrim: opening.trimmed || closing.trimmed,
      financing: dollars(financing),
      overnightCosts: dollars(opening.trade.fees + closing.trade.fees),
      conflicts: overlay.conflicts,
      capacityTrims: overlay.trims,
      missingEntries: overlay.missingEntries,
      fills: overlay.fills,
      heldGaps: overlay.heldGaps,
    }
  })
}

export type LedgerRow = ReturnType<typeof replayAccount>[number]
export const noiseIdentity = (daily: readonly DailyFrame[], days: readonly (readonly NoiseOrder[])[]) =>
  daily.map(({ date }, i) => dollars(tradeNoise(date, days[i], 1, initial, combinedCap, book(), 1).netPnl))
