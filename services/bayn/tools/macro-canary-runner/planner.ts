import { Result } from 'effect'

import { sha256 } from '../../src/hash'
import { Side, type Account, type Bar, type OpenOrder, type OrderRequest, type Position } from './alpaca'
import { failure, type Options } from './contract'
import { etfs, type Etf } from './signals'

export const overnightCapCents = 15_000_000
const intradayCapCents = 18_000_000
const collarBp = 15
const driftBand = 0.1
const microsPerCent = 10_000
const intradaySymbols = ['QQQ', 'SMH']
const wholeShares = (qty: string) => Number(qty.split('.')[0])

// Broker decimal money can have sub-cent precision. Round capacity down and exposures up.
export const cents = (value: string, roundUp = false): number => {
  const [whole, fraction = ''] = value.split('.')
  return (
    Number(whole) * 100 +
    Number(fraction.slice(0, 2).padEnd(2, '0')) +
    Number(roundUp && /[1-9]/.test(fraction.slice(2)))
  )
}

const rawPositionGross = (qty: string, priceMicros: number) => {
  const [whole, fraction = ''] = qty.replace(/^-/, '').split('.')
  const microsTimesShares = BigInt(whole + fraction) * BigInt(priceMicros)
  const divisor = BigInt(microsPerCent) * 10n ** BigInt(fraction.length)
  return Number((microsTimesShares + divisor - 1n) / divisor)
}

const limitCents = (referenceMicros: number, side: Side) => {
  const scaled = referenceMicros * (side === Side.Buy ? 10_000 + collarBp : 10_000 - collarBp)
  const priceCents = scaled / (10_000 * microsPerCent)
  return side === Side.Buy ? Math.floor(priceCents) : Math.ceil(priceCents)
}

export type Snapshot = {
  account: Account
  positions: readonly Position[]
  openOrders: readonly OpenOrder[]
}
export const orderPrefix = (accountId: string, session: string) =>
  `bayn-mc-${session}-${sha256(accountId).slice(0, 12)}-`

type PlannedOrder = {
  request: OrderRequest
  referenceNotionalMicros: number
  limitNotionalCents: number
}

export const planRebalance = (
  snapshot: Snapshot,
  options: Options,
  executionDate: string,
  reviewDue: boolean,
  targets: readonly { symbol: Etf; weight: number }[],
  rawBars: readonly { symbol: Etf; bar: Bar }[],
) =>
  Result.gen(function* () {
    const { account, positions, openOrders } = snapshot
    const excluded = new Set(options.excludeSymbols)
    if (excluded.size > 0 || options.capitalBudgetCents !== undefined)
      for (const symbol of intradaySymbols) excluded.add(symbol)
    const managed = new Set<string>(etfs.filter((symbol) => !excluded.has(symbol)))
    const bySymbol = new Map<string, Position>()
    const positionGrossCents = new Map<string, number>()
    const rawBySymbol = new Map<string, number>()
    for (const { symbol, bar } of rawBars) {
      const price = Math.round(bar.c * 1_000_000)
      if (!(price >= 1_000_000 && price <= 100_000_000_000))
        return yield* Result.fail(failure('sizing', `Unsupported raw ETF close for ${symbol}`))
      rawBySymbol.set(symbol, price)
    }

    const equityCents = Number(account.equity) > 0 ? cents(account.equity) : 0
    const cashCents = Number(account.cash) > 0 ? cents(account.cash) : 0
    const buyingPowerCents = Number(account.buying_power) > 0 ? cents(account.buying_power) : 0
    if (equityCents <= 0) return yield* Result.fail(failure('reconcile', 'Paper account must have positive equity'))
    let managedGross = 0
    let otherGross = 0
    for (const position of positions) {
      const { symbol } = position
      const qty = Number(position.qty)
      const available = Number(position.qty_available ?? position.qty)
      const marketValue = Number(position.market_value)
      const rawMicros = rawBySymbol.get(symbol)
      const sign = position.side === 'long' ? 1 : -1
      if (
        bySymbol.has(symbol) ||
        qty * sign <= 0 ||
        marketValue * sign <= 0 ||
        (managed.has(symbol) &&
          (position.side !== 'long' || available < 0 || available > qty || rawMicros === undefined))
      )
        return yield* Result.fail(failure('reconcile', `Unsupported or inconsistent paper position for ${symbol}`))
      const rawGross = rawMicros === undefined ? 0 : rawPositionGross(position.qty, rawMicros)
      const gross = Math.max(rawGross, cents(position.market_value.replace(/^-/, ''), true))
      if (!Number.isSafeInteger(gross))
        return yield* Result.fail(failure('reconcile', `Position notional is out of range for ${symbol}`))
      bySymbol.set(symbol, position)
      positionGrossCents.set(symbol, gross)
      if (managed.has(symbol)) managedGross += gross
      else otherGross += gross
    }
    if (!Number.isSafeInteger(managedGross + otherGross))
      return yield* Result.fail(failure('reconcile', 'Total account gross is out of range'))
    const budgetCents = Math.max(
      0,
      Math.min(
        options.capitalBudgetCents ?? overnightCapCents,
        overnightCapCents - otherGross,
        equityCents - otherGross,
      ),
    )
    const blocked =
      openOrders.length > 0
        ? 'Outstanding account orders can change quantities, cash or gross'
        : account.account_blocked || account.trading_blocked || account.trade_suspended_by_user
          ? 'Broker account is blocked for trading'
          : null
    const outsideDriftBand = (target: number, current: number | null, held: number) =>
      current === null ? held > 0 : Math.abs(target - current) + 1e-12 >= driftBand
    const strategic = []
    for (const { symbol, weight } of targets) {
      const referenceMicros = rawBySymbol.get(symbol)
      if (referenceMicros === undefined)
        return yield* Result.fail(failure('sizing', `Missing raw ETF close for ${symbol}`))
      const inSleeve = managed.has(symbol)
      const position = bySymbol.get(symbol)
      const held = Number(position?.qty ?? 0)
      const currentWeight = budgetCents > 0 ? (held * referenceMicros) / (budgetCents * microsPerCent) : null
      strategic.push({ symbol, weight, inSleeve, referenceMicros, position, held, currentWeight })
    }
    const excludedTargetWeight = strategic.reduce((sum, input) => sum + (input.inSleeve ? 0 : input.weight), 0)
    const rebalanceDue =
      reviewDue &&
      strategic.some(
        ({ inSleeve, weight, currentWeight, held }) => inSleeve && outsideDriftBand(weight, currentWeight, held),
      )
    // Once a review calls for a rebalance, sweep what the band leaves idle. Retained shares and excluded
    // allocations are not available for the sweep. SHY's strategic allocation and sweep net to one order.
    const intendedNonShyWeight = strategic.reduce((sum, input) => {
      if (!input.inSleeve || input.symbol === 'SHY') return sum
      const current = input.currentWeight ?? 0
      return sum + (outsideDriftBand(input.weight, input.currentWeight, input.held) ? input.weight : current)
    }, 0)
    const sweepTargetWeight = Math.max(0, 1 - excludedTargetWeight - intendedNonShyWeight)

    const candidates = []
    const sizing = []
    for (const { symbol, weight, inSleeve, referenceMicros, position, held, currentWeight } of strategic) {
      const targetWeight = inSleeve ? (symbol === 'SHY' && rebalanceDue ? sweepTargetWeight : weight) : 0
      const targetCents = Math.floor(targetWeight * budgetCents)
      const side = targetCents * microsPerCent > held * referenceMicros ? Side.Buy : Side.Sell
      const limit = limitCents(referenceMicros, side)
      const riskUnitCents = Math.max(
        limit,
        Math.ceil(referenceMicros / microsPerCent),
        held > 0 ? Math.ceil((positionGrossCents.get(symbol) ?? 0) / held) : 0,
      )
      const outsideBand = inSleeve && outsideDriftBand(targetWeight, currentWeight, held)
      const desiredQuantity =
        side === Side.Buy
          ? Math.max(0, Math.floor(targetCents / riskUnitCents - held))
          : Math.min(
              wholeShares(position?.qty ?? '0'),
              wholeShares(position?.qty_available ?? position?.qty ?? '0'),
              Math.max(0, Math.floor(held - (targetCents * microsPerCent) / referenceMicros)),
            )
      sizing.push({ symbol, managed: inSleeve, referenceMicros, currentWeight, targetWeight, outsideBand })
      if (rebalanceDue && blocked === null && outsideBand && desiredQuantity > 0)
        candidates.push({ symbol, side, desiredQuantity, limit, referenceMicros, riskUnitCents })
    }

    let desiredBuyCost = 0
    let desiredBuyGross = 0
    for (const candidate of candidates) {
      if (candidate.side !== Side.Buy) continue
      desiredBuyCost += candidate.limit * candidate.desiredQuantity
      desiredBuyGross += candidate.riskUnitCents * candidate.desiredQuantity
    }
    // A sell may not fill at the next open. Clip buys without counting its proceeds or released gross.
    const buyCash = Math.min(cashCents, buyingPowerCents)
    const buyGrossRoom = Math.max(0, budgetCents - managedGross)
    const buyScale = desiredBuyCost === 0 ? 1 : Math.min(1, buyCash / desiredBuyCost, buyGrossRoom / desiredBuyGross)
    const orders: PlannedOrder[] = []
    let buyGross = 0
    let buyLimitNotionalCents = 0
    let sellLimitNotionalCents = 0
    let referenceNotionalMicros = 0
    for (const side of [Side.Sell, Side.Buy]) {
      for (const order of candidates) {
        if (order.side !== side) continue
        const qty = side === Side.Buy ? Math.floor(order.desiredQuantity * buyScale) : order.desiredQuantity
        if (qty === 0) continue
        const limitNotional = qty * order.limit
        const referenceNotional = qty * order.referenceMicros
        if (side === Side.Buy) {
          buyGross += qty * order.riskUnitCents
          buyLimitNotionalCents += limitNotional
        } else {
          sellLimitNotionalCents += limitNotional
        }
        referenceNotionalMicros += referenceNotional
        orders.push({
          request: {
            symbol: order.symbol,
            side,
            qty: String(qty),
            type: 'limit',
            time_in_force: options.tif,
            limit_price: (order.limit / 100).toFixed(2),
            extended_hours: false,
            client_order_id: orderPrefix(account.id, executionDate) + order.symbol,
          },
          referenceNotionalMicros: referenceNotional,
          limitNotionalCents: limitNotional,
        })
      }
    }

    const maximumProjectedGrossCents = managedGross + otherGross + buyGross
    if (
      !Number.isSafeInteger(referenceNotionalMicros) ||
      !Number.isSafeInteger(sellLimitNotionalCents) ||
      buyLimitNotionalCents > buyCash ||
      buyGross > buyGrossRoom ||
      (buyGross > 0 &&
        (maximumProjectedGrossCents > overnightCapCents || maximumProjectedGrossCents > intradayCapCents))
    )
      return yield* Result.fail(failure('sizing', 'Pre-trade notional, funding or gross invariant failed'))

    return {
      excludedSymbols: [...excluded].sort(),
      excludedTargetWeight,
      rebalanceDue,
      blocked,
      driftBand,
      collarBp,
      sizing,
      orders,
      budgetCents,
      cashCents,
      buyingPowerCents,
      equityCents,
      managedGrossCents: managedGross,
      otherGrossCents: otherGross,
      usedBuyScale: buyScale,
      overnightCapCents,
      intradayCapCents,
      maximumProjectedGrossCents,
      remainingIntradayGrossCents: Math.max(0, intradayCapCents - maximumProjectedGrossCents),
      buyLimitNotionalCents,
      sellLimitNotionalCents,
      referenceNotionalMicros,
      expectedTurnover: referenceNotionalMicros / (2 * equityCents * microsPerCent),
      expectedSleeveTurnover: budgetCents > 0 ? referenceNotionalMicros / (2 * budgetCents * microsPerCent) : null,
    }
  })
