import { Result } from 'effect'
import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { quantityScale } from '../quantity'
import type { ExecutionOrderPlan } from './execution-plans'
import { SystemAssessmentError } from './economics'
import type { SystemSourceCut } from './source-cut'

type Receipt = SystemSourceCut['orders'][number]

export const nativeOrderEvidenceAssumptions = [
  'Broker order and fill observations are authentic and retain provider timestamps and atomic units.',
  'Broker-generated child identities come from the nested protection response checked against the immutable parent intent at ingestion.',
  'Retained protection intents, approved risk decisions and reconciliations are authentic records from the registered account and authority generation; their hashes identify content rather than authenticate approval.',
  'Native protection and reconciled liquidation pricing are supported only by actual broker receipts and their retained conditional order or forced-close authority.',
] as const

/** Reproduce broker-generated children from the parent's sealed native protection. */
export const resolveExecutionOrderTerms = (
  brokerOrderId: string,
  root: Receipt,
  children: readonly Receipt[],
  plan: ExecutionOrderPlan,
) =>
  Result.gen(function* () {
    const { target, risk, document, intentId } = plan
    const parent = root.order
    const receipt =
      parent.brokerOrderId === brokerOrderId ? root : children.find((row) => row.order.brokerOrderId === brokerOrderId)
    if (receipt === undefined)
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Filled broker order is not in its retained native group' }),
      )
    const order = receipt.order
    const isRoot = brokerOrderId === parent.brokerOrderId
    const all = [root, ...children]
    if (
      all.some(
        (row) =>
          row.intentId !== intentId ||
          row.order.intentId !== intentId ||
          row.decisionId !== plan.decisionId ||
          row.authorityGenerationHash !== document.bindings.authorityGenerationHash ||
          row.order.accountId !== document.bindings.accountId ||
          row.order.symbol !== target.symbol,
      ) ||
      parent.parentBrokerOrderId !== undefined ||
      parent.side !== target.side ||
      parent.orderType !== target.orderType ||
      parent.timeInForce !== target.timeInForce ||
      parent.quantityAtoms !== target.quantityAtoms ||
      parent.notionalMicros !== undefined ||
      parent.limitPriceMicros !== risk.limitPriceMicros ||
      (!isRoot && order.parentBrokerOrderId !== parent.brokerOrderId)
    )
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Broker order differs from its sealed target or ownership' }),
      )
    const protection = risk.protection
    const group = protection?._tag === 'Bracket' || protection?._tag === 'Oco' ? protection : undefined
    if (group === undefined) {
      if (
        children.length !== 0 ||
        !isRoot ||
        parent.stopPriceMicros !== (protection?._tag === 'StopLimit' ? protection.stopPriceMicros : undefined)
      )
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Broker children or stop trigger lack sealed protection terms' }),
        )
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
    const stop = children.find((row) => row.order.orderType === OrderType.StopLimit)?.order
    const profit = bracket ? children.find((row) => row.order.orderType === OrderType.Limit)?.order : parent
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
      new Set(all.map((row) => row.order.brokerOrderId)).size !== all.length ||
      new Set(all.map((row) => row.order.clientOrderId)).size !== all.length ||
      children.some((row) => row.order.parentBrokerOrderId !== parent.brokerOrderId) ||
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
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Broker protection group differs from its sealed native terms' }),
      )
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
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Filled broker order is not a sealed protective leg' }),
      )
    const quantityAtoms = order.quantityAtoms
    const limitPriceMicros = order.limitPriceMicros
    if (quantityAtoms === undefined || limitPriceMicros === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Protective leg quantity or limit is missing' }))
    return { _tag: 'Bound' as const, order, root: parent, quantityAtoms, limitPriceMicros, protection: group._tag }
  })
