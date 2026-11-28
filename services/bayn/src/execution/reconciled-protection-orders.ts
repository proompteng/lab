import { isDeepStrictEqual } from 'node:util'
import { Result } from 'effect'

import { OrderClass, OrderStatus as BrokerOrderStatus, type Order as BrokerOrder } from '../broker/alpaca/model'
import { verifyProtectionGroup } from '../broker/alpaca/protection-group'
import { orderObservation } from '../broker/observations'
import type { ReconciliationPassResult } from '../reconciler'
import { isBracketProtection, isEquityShortProtection, OrderStatus, type Order } from './contracts'

const pending = (order: Order) =>
  order.status === OrderStatus.New ||
  order.status === OrderStatus.Pending ||
  order.status === OrderStatus.PartiallyFilled

/**
 * Reconciliation proves economics; the original nested read and immutable intent prove child identity.
 * Reproduce every admitted order against that same reconciled state before carrying its actual raw
 * exposure into the existing fresh-snapshot and capital checks. Unknown or incomplete groups stay blocked.
 */
export const reconciledOpenProtectionOrders = (result: ReconciliationPassResult): readonly BrokerOrder[] | null => {
  const { brokerState } = result
  const active = brokerState.orders.filter(pending)
  if (active.length === 0) return []
  const byId = new Map(brokerState.orders.map((order) => [order.brokerOrderId, order]))
  if (byId.size !== brokerState.orders.length) return null
  const activeIds = new Set(active.map((order) => order.brokerOrderId))
  const admitted = new Map<string, BrokerOrder>()
  const parents = new Set<string>()
  const clients = new Set<string>()
  const residualBySymbol = new Map<string, bigint>()
  for (const group of result.protectionGroups ?? []) {
    const parent = group.parent.value
    const children = parent.legs ?? []
    if (!children.some((child) => activeIds.has(child.brokerOrderId))) continue
    const verified = verifyProtectionGroup(parent, group)
    if (
      Result.isFailure(verified) ||
      !isBracketProtection(group.protection) ||
      parent.parentBrokerOrderId !== undefined ||
      parent.accountId !== brokerState.account.accountId ||
      parent.symbol !== group.symbol ||
      parent.status !== BrokerOrderStatus.Filled ||
      parent.filledQuantityAtoms !== group.quantityAtoms ||
      parents.has(parent.brokerOrderId) ||
      children.length !== 2 ||
      children.some(
        (child) =>
          !activeIds.has(child.brokerOrderId) ||
          (child.orderClass !== OrderClass.Simple && child.orderClass !== OrderClass.Bracket) ||
          child.legs !== undefined,
      )
    )
      return null
    parents.add(parent.brokerOrderId)
    for (const order of [parent, ...children]) {
      const normalized = orderObservation(order, group.parent.evidence, group.intentId)
      if (
        Result.isFailure(normalized) ||
        normalized.success._tag !== 'Order' ||
        !isDeepStrictEqual(normalized.success.order, byId.get(order.brokerOrderId)) ||
        clients.has(order.clientOrderId)
      )
        return null
      clients.add(order.clientOrderId)
    }
    const residual =
      BigInt(group.quantityAtoms) - children.reduce((sum, child) => sum + BigInt(child.filledQuantityAtoms), 0n)
    if (residual <= 0n) return null
    const signed = isEquityShortProtection(group.protection) ? -residual : residual
    const previous = residualBySymbol.get(group.symbol) ?? 0n
    if (previous !== 0n && previous < 0n !== signed < 0n) return null
    residualBySymbol.set(group.symbol, previous + signed)
    for (const child of children) {
      if (admitted.has(child.brokerOrderId)) return null
      admitted.set(child.brokerOrderId, child)
    }
  }
  if (admitted.size !== active.length) return null
  for (const [symbol, residual] of residualBySymbol) {
    const positions = brokerState.positions.filter((position) => position.symbol === symbol)
    if (positions.length !== 1) return null
    const position = positions[0]
    if (position === undefined || position.accountId !== brokerState.account.accountId) return null
    const quantity = BigInt(position.quantityAtoms)
    if (residual > 0n ? quantity < residual : quantity > residual) return null
  }
  return [...admitted.values()]
}
