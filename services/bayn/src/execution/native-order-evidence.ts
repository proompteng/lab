import { Result } from 'effect'
import { OrderSide, OrderType, TimeInForce, type Order, type NativeProtection } from './contracts'
import { quantityScale } from '../quantity'

export interface NativeOrderPlan {
  readonly intentId: string
  readonly accountId: string
  readonly target: Pick<Order, 'symbol' | 'side' | 'orderType' | 'timeInForce'> & { readonly quantityAtoms: string }
  readonly risk: { readonly limitPriceMicros: string; readonly protection?: NativeProtection }
}

/** Reproduce broker-generated children from the parent's sealed native protection. */
export const resolveNativeOrderTerms = (
  brokerOrderId: string,
  parent: Order,
  children: readonly Order[],
  plan: NativeOrderPlan,
) =>
  Result.gen(function* () {
    const { target, risk, accountId, intentId } = plan
    const order =
      parent.brokerOrderId === brokerOrderId ? parent : children.find((row) => row.brokerOrderId === brokerOrderId)
    if (order === undefined) return yield* Result.fail('Filled broker order is not in its retained native group')
    const isRoot = brokerOrderId === parent.brokerOrderId
    const all = [parent, ...children]
    if (
      all.some((row) => row.intentId !== intentId || row.accountId !== accountId || row.symbol !== target.symbol) ||
      parent.parentBrokerOrderId !== undefined ||
      parent.side !== target.side ||
      parent.orderType !== target.orderType ||
      parent.timeInForce !== target.timeInForce ||
      parent.quantityAtoms !== target.quantityAtoms ||
      parent.notionalMicros !== undefined ||
      parent.limitPriceMicros !== risk.limitPriceMicros ||
      (!isRoot && order.parentBrokerOrderId !== parent.brokerOrderId)
    )
      return yield* Result.fail('Broker order differs from its sealed target or ownership')
    const protection = risk.protection
    const group = protection?._tag === 'Bracket' || protection?._tag === 'Oco' ? protection : undefined
    if (group === undefined) {
      if (
        children.length !== 0 ||
        !isRoot ||
        parent.stopPriceMicros !== (protection?._tag === 'StopLimit' ? protection.stopPriceMicros : undefined)
      )
        return yield* Result.fail('Broker children or stop trigger lack sealed protection terms')
      return {
        _tag: 'Bound' as const,
        order,
        root: parent,
        quantityAtoms: target.quantityAtoms,
        limitPriceMicros: risk.limitPriceMicros,
        protection: null,
      }
    }
    const bracket = group._tag === 'Bracket'
    const expectedChildren = bracket ? 2 : 1
    if (children.length < expectedChildren)
      return { _tag: 'Missing' as const, reason: 'MISSING_NATIVE_PROTECTION_LEGS' }
    const stop = children.find((row) => row.orderType === OrderType.StopLimit)
    const profit = bracket ? children.find((row) => row.orderType === OrderType.Limit) : parent
    const maximum = BigInt(target.quantityAtoms)
    if (
      children.length !== expectedChildren ||
      stop === undefined ||
      profit === undefined ||
      maximum <= 0n ||
      maximum % quantityScale !== 0n ||
      parent.side !== (bracket ? OrderSide.Buy : OrderSide.Sell) ||
      parent.orderType !== OrderType.Limit ||
      parent.timeInForce !== TimeInForce.Day ||
      parent.stopPriceMicros !== undefined ||
      new Set(all.map((row) => row.brokerOrderId)).size !== all.length ||
      new Set(all.map((row) => row.clientOrderId)).size !== all.length ||
      children.some((row) => row.parentBrokerOrderId !== parent.brokerOrderId) ||
      [stop, profit].some(
        (leg) =>
          leg.side !== OrderSide.Sell ||
          leg.timeInForce !== TimeInForce.Day ||
          leg.notionalMicros !== undefined ||
          BigInt(leg.quantityAtoms ?? '0') <= 0n ||
          BigInt(leg.quantityAtoms ?? '0') > maximum,
      ) ||
      stop.stopPriceMicros !== group.stopPriceMicros ||
      stop.limitPriceMicros !== group.stopLimitPriceMicros ||
      profit.limitPriceMicros !== group.profitLimitPriceMicros ||
      profit.stopPriceMicros !== undefined
    )
      return yield* Result.fail('Broker protection group differs from its sealed native terms')
    if (isRoot)
      return {
        _tag: 'Bound' as const,
        order,
        root: parent,
        quantityAtoms: target.quantityAtoms,
        limitPriceMicros: risk.limitPriceMicros,
        protection: group._tag,
      }
    if (order.brokerOrderId !== stop.brokerOrderId && order.brokerOrderId !== profit.brokerOrderId)
      return yield* Result.fail('Filled broker order is not a sealed protective leg')
    const quantityAtoms = order.quantityAtoms
    const limitPriceMicros = order.limitPriceMicros
    if (quantityAtoms === undefined || limitPriceMicros === undefined)
      return yield* Result.fail('Protective leg quantity or limit is missing')
    return { _tag: 'Bound' as const, order, root: parent, quantityAtoms, limitPriceMicros, protection: group._tag }
  })
