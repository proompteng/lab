import { Result } from 'effect'

import type { NativeProtection } from '../../execution/contracts'
import { quantityScale } from '../../quantity'
import { OrderClass, OrderSide, OrderType, TimeInForce, type Order } from './model'

/** The nested broker response establishes child identity; the immutable intent establishes its terms. */
export const verifyProtectionGroup = (
  parent: Order,
  expected: { readonly symbol: string; readonly quantityAtoms: string; readonly protection: NativeProtection },
): Result.Result<readonly Order[], string> => {
  const terms = expected.protection
  if (terms._tag === 'StopLimit') return Result.fail('a standalone stop has no broker-generated children')
  const legs = parent.legs ?? []
  const bracket = terms._tag === 'Bracket'
  const stop = legs.find((leg) => leg.orderType === OrderType.StopLimit)
  const profit = bracket ? legs.find((leg) => leg.orderType === OrderType.Limit) : parent
  const all = [parent, ...legs]
  const original = BigInt(expected.quantityAtoms)
  if (
    original <= 0n ||
    original % quantityScale !== 0n ||
    parent.quantityAtoms !== expected.quantityAtoms ||
    parent.orderClass !== (bracket ? OrderClass.Bracket : OrderClass.OneCancelsOther) ||
    parent.side !== (bracket ? OrderSide.Buy : OrderSide.Sell) ||
    legs.length !== (bracket ? 2 : 1) ||
    stop === undefined ||
    profit === undefined ||
    new Set(all.map((order) => order.brokerOrderId)).size !== all.length ||
    new Set(all.map((order) => order.clientOrderId)).size !== all.length
  )
    return Result.fail('broker protection group does not match its parent identity, class, or quantity')
  for (const order of [stop, profit]) {
    const quantity = BigInt(order.quantityAtoms ?? '0')
    if (
      order.accountId !== parent.accountId ||
      order.symbol !== expected.symbol ||
      order.side !== OrderSide.Sell ||
      order.timeInForce !== TimeInForce.Day ||
      order.extendedHours ||
      order.notionalMicros !== undefined ||
      quantity <= 0n ||
      quantity > original ||
      (order !== parent && order.parentBrokerOrderId !== parent.brokerOrderId)
    )
      return Result.fail('broker protection leg has invalid identity, side, duration, or quantity')
  }
  if (
    stop.stopPriceMicros !== terms.stopPriceMicros ||
    stop.limitPriceMicros !== terms.stopLimitPriceMicros ||
    profit.limitPriceMicros !== terms.profitLimitPriceMicros ||
    profit.stopPriceMicros !== undefined
  )
    return Result.fail('broker protection prices differ from the strategy plan')
  const stopRemaining = BigInt(stop.quantityAtoms ?? '0') - BigInt(stop.filledQuantityAtoms)
  const profitRemaining = BigInt(profit.quantityAtoms ?? '0') - BigInt(profit.filledQuantityAtoms)
  const residual = original - BigInt(stop.filledQuantityAtoms) - BigInt(profit.filledQuantityAtoms)
  // A partial take-profit changes the sibling stop quantity. During broker cancellation races
  // the group may already be terminal; current coverage is checked again before any replacement.
  if (residual > 0n && (stopRemaining < residual || profitRemaining < residual))
    return Result.fail('broker protection does not cover the remaining position')
  return Result.succeed(legs)
}
