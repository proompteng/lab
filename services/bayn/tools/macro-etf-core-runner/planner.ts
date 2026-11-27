import { Result } from 'effect'

import { sha256 } from '../../src/hash'
import { rebalanceDue } from '../../src/strategy/macro-etf-core/planner'
import { parameters, universe } from '../../src/strategy/macro-etf-core/policy'
import { Side, type OrderRequest } from '../macro-canary-runner/alpaca'
import {
  cents,
  collarBp,
  intradayCapCents,
  limitCents,
  microsPerCent,
  overnightCapCents,
  type Snapshot,
} from '../macro-canary-runner/planner'
import type { Allocation } from './allocation'
import { failure, type Options } from './contract'
import type { Market } from './market'

const shareScale = 10n ** 18n
const abs = (value: bigint) => (value < 0n ? -value : value)
const shares = (decimal: string) => {
  const [whole, fraction = ''] = decimal.replace(/^-/, '').split('.')
  return BigInt(whole + fraction.padEnd(18, '0')) * (decimal.startsWith('-') ? -1n : 1n)
}

export const orderPrefix = (accountId: string, session: string) =>
  `bayn-mec-${session}-${sha256(accountId).slice(0, 12)}-`

export const planRebalance = (snapshot: Snapshot, options: Options, allocation: Allocation, market: Market) =>
  Result.gen(function* () {
    const { account, positions, openOrders } = snapshot
    const protectedSymbols = new Set(allocation.excludedSymbols)
    const managed = new Set<string>(universe.filter((symbol) => !protectedSymbols.has(symbol)))
    const marks = new Map<string, number>()
    for (const { symbol, bar } of market.rawBars) {
      const price = Math.round(bar.c * 1_000_000)
      if (!(price >= 1_000_000 && price <= 100_000_000_000))
        return yield* Result.fail(failure('sizing', `Unsupported raw ETF close for ${symbol}`))
      marks.set(symbol, price)
    }
    const equityCents = Number(account.equity) > 0 ? cents(account.equity) : 0
    const cashCents = Number(account.cash) > 0 ? cents(account.cash) : 0
    const buyingPowerCents = Number(account.buying_power) > 0 ? cents(account.buying_power) : 0
    if (equityCents <= 0) return yield* Result.fail(failure('reconcile', 'Paper account must have positive equity'))

    const inventory = new Map<string, { held: bigint; available: bigint; gross: number }>()
    let managedGrossCents = 0
    let reservedGrossCents = 0
    for (const position of positions) {
      const { symbol } = position
      const held = shares(position.qty)
      const available = shares(position.qty_available ?? '0')
      const isManaged = managed.has(symbol)
      const sign = position.side === 'long' ? 1n : -1n
      const price = marks.get(symbol)
      if (
        inventory.has(symbol) ||
        held * sign <= 0n ||
        Number(position.market_value) * Number(sign) <= 0 ||
        (isManaged &&
          (sign < 0n ||
            position.qty_available === undefined ||
            available < 0n ||
            available > held ||
            price === undefined))
      )
        return yield* Result.fail(failure('reconcile', `Unsupported or inconsistent paper position for ${symbol}`))

      const divisor = shareScale * BigInt(microsPerCent)
      const markGross = (abs(held) * BigInt(price ?? 0) + divisor - 1n) / divisor
      const gross = Math.max(Number(markGross), cents(position.market_value.replace(/^-/, ''), true))
      inventory.set(symbol, { held, available, gross })
      if (isManaged) managedGrossCents += gross
      else reservedGrossCents += gross
    }
    const currentGrossCents = managedGrossCents + reservedGrossCents
    if (!Number.isSafeInteger(currentGrossCents))
      return yield* Result.fail(failure('reconcile', 'Total account gross is out of range'))
    const budgetCents = Math.max(
      0,
      Math.min(options.capitalBudgetCents, overnightCapCents - reservedGrossCents, equityCents - reservedGrossCents),
    )
    const budgetMicros = BigInt(budgetCents) * BigInt(microsPerCent)
    const blocked =
      openOrders.length > 0
        ? 'Outstanding account orders can change quantities, cash or gross'
        : account.account_blocked || account.trading_blocked || account.trade_suspended_by_user
          ? 'Broker account is blocked for trading'
          : null

    const candidates = []
    const drift = []
    for (const { symbol, weight } of allocation.targets ?? []) {
      if (!managed.has(symbol)) continue
      const price = marks.get(symbol)
      if (price === undefined) return yield* Result.fail(failure('sizing', `Missing raw ETF close for ${symbol}`))
      const position = inventory.get(symbol)
      const held = position?.held ?? 0n
      const priorMicros = (held * BigInt(price)) / shareScale
      drift.push({ weight, priorMicros })
      const targetCents = Math.floor(weight * budgetCents)
      const side = BigInt(targetCents) * BigInt(microsPerCent) > priorMicros ? Side.Buy : Side.Sell
      const limit = limitCents(price, side)
      const markedUnitCents =
        position === undefined ? 0 : Math.ceil(position.gross / (Number(held) / Number(shareScale)))
      // A buy must fit at the worse of its limit, review mark and broker inventory mark.
      const unitGross = Math.max(limit, Math.ceil(price / microsPerCent), markedUnitCents)
      const quantity =
        side === Side.Buy
          ? Math.floor(targetCents / unitGross - Number(held) / Number(shareScale))
          : Math.min(
              Number((position?.available ?? 0n) / shareScale),
              Number(held / shareScale) - Math.floor((targetCents * microsPerCent) / price),
            )
      if (quantity > 0) candidates.push({ symbol, side, price, limit, unitGross, quantity })
    }

    const reviewDue = allocation.targets !== null
    const rebalance = reviewDue && (budgetMicros === 0n ? managedGrossCents > 0 : rebalanceDue(drift, budgetMicros))
    const eligible = rebalance && blocked === null ? candidates : []
    const buys = eligible.filter(({ side }) => side === Side.Buy)
    const desiredBuyCost = buys.reduce((sum, order) => sum + order.quantity * order.limit, 0)
    const desiredBuyGross = buys.reduce((sum, order) => sum + order.quantity * order.unitGross, 0)
    // Cap buys against current gross, cash and buying power; never assume a sell fills.
    const spend = Math.min(cashCents, buyingPowerCents)
    const grossRoom = Math.max(0, budgetCents - managedGrossCents)
    const buyScale = desiredBuyCost === 0 ? 1 : Math.min(1, spend / desiredBuyCost, grossRoom / desiredBuyGross)

    const orders: { request: OrderRequest; referenceNotionalMicros: number; limitNotionalCents: number }[] = []
    const prefix = orderPrefix(account.id, market.window.executionDate)
    let buyGrossCents = 0
    let buyLimitNotionalCents = 0
    for (const order of [...eligible.filter(({ side }) => side === Side.Sell), ...buys]) {
      const quantity = order.side === Side.Buy ? Math.floor(order.quantity * buyScale) : order.quantity
      if (quantity <= 0) continue
      const referenceNotionalMicros = quantity * order.price
      const limitNotionalCents = quantity * order.limit
      if (!Number.isSafeInteger(referenceNotionalMicros) || !Number.isSafeInteger(limitNotionalCents))
        return yield* Result.fail(failure('sizing', 'Order notional is out of range'))
      if (order.side === Side.Buy) {
        buyGrossCents += quantity * order.unitGross
        buyLimitNotionalCents += limitNotionalCents
      }
      orders.push({
        request: {
          symbol: order.symbol,
          qty: String(quantity),
          side: order.side,
          type: 'limit',
          time_in_force: options.tif,
          limit_price: (order.limit / 100).toFixed(2),
          extended_hours: false,
          client_order_id: prefix + order.symbol,
        },
        referenceNotionalMicros,
        limitNotionalCents,
      })
    }
    const maximumProjectedGrossCents = currentGrossCents + buyGrossCents
    if (
      buyLimitNotionalCents > spend ||
      buyGrossCents > grossRoom ||
      (buyGrossCents > 0 && maximumProjectedGrossCents > Math.min(overnightCapCents, intradayCapCents))
    )
      return yield* Result.fail(failure('sizing', 'Pre-trade funding or gross invariant failed'))

    return {
      blocked,
      reviewDue,
      rebalanceDue: rebalance,
      collarBps: collarBp,
      deadbandBps: parameters.deadbandBps,
      budgetCents,
      cashCents,
      buyingPowerCents,
      equityCents,
      managedGrossCents,
      reservedGrossCents,
      overnightCapCents,
      intradayCapCents,
      maximumProjectedGrossCents,
      remainingIntradayGrossCents: Math.max(0, intradayCapCents - maximumProjectedGrossCents),
      buyLimitNotionalCents,
      orders,
    }
  })
