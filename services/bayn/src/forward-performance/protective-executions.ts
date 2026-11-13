import { Result, Schema } from 'effect'

import { NativeProtectionSchema, OrderSchema, OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { resolveNativeOrderTerms } from '../execution/native-order-evidence'
import { UtcInstantSchema, strictParseOptions } from '../schemas'
import type { ForwardPerformanceExecutionEvidence } from './model'

/** Preserve the BUY intent; only the broker-generated children execute conditional SELLs. */
export const protectiveExecutionOrders = (evidence: ForwardPerformanceExecutionEvidence, asOf: string | undefined) =>
  Result.gen(function* () {
    const native = evidence.nativeProtection
    if (native === undefined) return []
    const protection = yield* Schema.decodeUnknownResult(
      NativeProtectionSchema,
      strictParseOptions,
    )(native.protection).pipe(Result.mapError(() => 'Invalid sealed protection terms'))
    if (native.intentId !== evidence.intentId) return yield* Result.fail('Protection differs from its sealed intent')
    if (evidence.intent?.terminalOutcome === 'BLOCKED' && native.orders.length === 0 && evidence.fills.length === 0)
      return []
    const parentReceipt = native.orders.find(
      (receipt) => receipt.order.brokerOrderId === evidence.terminalOrder?.brokerOrderId,
    )
    const parent = parentReceipt?.order
    const planned = evidence.plannedQuantityAtoms
    if (
      parent === undefined ||
      parentReceipt === undefined ||
      planned === undefined ||
      native.intentId !== evidence.intentId
    )
      return yield* Result.fail('Protection lacks its exact sealed parent intent and order')
    const terminal = evidence.terminalOrder
    if (
      terminal === undefined ||
      parentReceipt.eventId !== terminal.eventId ||
      parentReceipt.occurredAt !== terminal.occurredAt ||
      parent.observedAt !== terminal.observedAt ||
      parent.filledQuantityAtoms !== terminal.filledQuantityAtoms ||
      parent.status !== terminal.status ||
      parent.clientOrderId !== terminal.clientOrderId
    )
      return yield* Result.fail('Protection parent differs from its execution receipt')
    for (const receipt of native.orders) {
      yield* Schema.decodeUnknownResult(UtcInstantSchema)(receipt.occurredAt).pipe(
        Result.mapError(() => 'Invalid native order occurrence clock'),
      )
      yield* Schema.decodeUnknownResult(
        OrderSchema,
        strictParseOptions,
      )(receipt.order).pipe(Result.mapError(() => 'Invalid native order receipt'))
      if (
        !/^[0-9a-f]{64}$/.test(receipt.eventId) ||
        asOf === undefined ||
        receipt.order.observedAt > asOf ||
        receipt.order.observedAt < receipt.occurredAt ||
        receipt.occurredAt < evidence.decisionCreatedAt ||
        !['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(receipt.order.status)
      )
        return yield* Result.fail('Native order lacks terminal evidence at the reconciled cut')
    }
    const children = native.orders.filter((receipt) => receipt !== parentReceipt)
    const resolved = yield* resolveNativeOrderTerms(
      parent.brokerOrderId,
      parent,
      children.map((row) => row.order),
      {
        intentId: evidence.intentId,
        accountId: evidence.accountId,
        target: {
          symbol: evidence.symbol,
          side: evidence.side === 'BUY' ? OrderSide.Buy : OrderSide.Sell,
          orderType: protection._tag === 'StopLimit' ? OrderType.StopLimit : OrderType.Limit,
          timeInForce: TimeInForce.Day,
          quantityAtoms: planned,
        },
        risk: { limitPriceMicros: native.limitPriceMicros, protection },
      },
    )
    if (resolved._tag !== 'Bound') return yield* Result.fail(resolved.reason)
    if (protection._tag !== 'Bracket') return children

    // Broker source sequence disambiguates fills within one nanosecond. Observation arrival order
    // cannot prove inventory ownership during a partial-fill / cancel race.
    const sequences = new Set<string>()
    for (const fill of evidence.fills) {
      if (
        fill.sourceSequence === undefined ||
        !/^(0|[1-9][0-9]*)$/.test(fill.sourceSequence) ||
        sequences.has(fill.sourceSequence) ||
        !/^[1-9][0-9]*$/.test(fill.quantityAtoms) ||
        !/^[1-9][0-9]*$/.test(fill.priceAtoms) ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9}Z$/.test(fill.sourceTimestamp) ||
        `${fill.sourceTimestamp.slice(0, 23)}Z` !== fill.occurredAt ||
        asOf === undefined ||
        fill.observedAt > asOf
      )
        return yield* Result.fail('Protection fills lack unique source ordering or positive quantities')
      sequences.add(fill.sourceSequence)
    }
    const fills = [...evidence.fills].sort(
      (a, b) =>
        a.sourceTimestamp.localeCompare(b.sourceTimestamp) ||
        (BigInt(a.sourceSequence ?? '0') < BigInt(b.sourceSequence ?? '0') ? -1 : 1),
    )
    let inventory = 0n
    for (const fill of fills) {
      const order = native.orders.find((receipt) => receipt.order.brokerOrderId === fill.brokerOrderId)?.order
      if (order === undefined || fill.side !== order.side)
        return yield* Result.fail('Fill is not bound to its native order')
      const limit = BigInt(order.limitPriceMicros ?? '0') * 1000n
      if (limit === 0n || (fill.side === 'BUY' ? BigInt(fill.priceAtoms) > limit : BigInt(fill.priceAtoms) < limit))
        return yield* Result.fail('Native fill violates its sealed limit price')
      inventory += (fill.side === 'BUY' ? 1n : -1n) * BigInt(fill.quantityAtoms)
      if (inventory < 0n || inventory > BigInt(planned))
        return yield* Result.fail('Protective fills exceed chronological parent inventory')
    }
    return children
  })
