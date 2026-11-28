import { Result, Schema } from 'effect'

import {
  NativeProtectionSchema,
  OrderSchema,
  OrderStatus,
  isBracketProtection,
  isOcoProtection,
} from '../execution/contracts'
import { resolveExecutionOrderTerms } from '../system-assessment/execution-order-terms'
import { UtcInstantSchema } from '../schemas'
import type {
  ForwardPerformanceEvidenceInput,
  ForwardPerformanceExecutionEvidence,
  ForwardPerformanceExecutionQualityReasonCode,
  ForwardPerformanceTransactionEvidence,
} from './model'

/** Conditional broker exits retain their own orders; they are never rewritten as strategy SELL intents. */
export const verifyForwardNativeProtection = (
  evidence: ForwardPerformanceExecutionEvidence,
  input: ForwardPerformanceEvidenceInput,
  transactions: ReadonlyMap<string, ForwardPerformanceTransactionEvidence>,
  blockedBeforeSubmission: boolean,
) => {
  const native = evidence.nativeProtection
  const reasons = new Set<ForwardPerformanceExecutionQualityReasonCode>()
  const fills = native?.fills ?? []
  const fail = (reason: ForwardPerformanceExecutionQualityReasonCode) => reasons.add(reason)
  if (native === undefined) return { reasons: [...reasons], fills }
  const protection = Schema.decodeUnknownResult(NativeProtectionSchema)(native.protection)
  const decodedOrders = Schema.decodeUnknownResult(Schema.Array(OrderSchema))(native.orders.map((row) => row.order))
  if (
    native.schemaVersion !== 'bayn.forward-performance-native-protection.v1' ||
    Result.isFailure(protection) ||
    Result.isFailure(decodedOrders) ||
    (!isBracketProtection(native.protection) && !isOcoProtection(native.protection)) ||
    !/^[a-f0-9]{64}$/.test(native.authorityGenerationHash) ||
    !/^[1-9][0-9]*$/.test(native.target.quantityAtoms) ||
    native.target.symbol !== evidence.symbol ||
    native.target.side !== evidence.side ||
    native.target.quantityAtoms !== evidence.plannedQuantityAtoms
  ) {
    fail('FILL_IDENTITY_DRIFT')
    return { reasons: [...reasons], fills }
  }
  // A durably blocked intent never created broker protection; actual receipts must still be verified.
  if (blockedBeforeSubmission && native.orders.length === 0 && fills.length === 0)
    return { reasons: [...reasons], fills }
  const roots = native.orders.filter((row) => row.order.parentBrokerOrderId === undefined)
  const root = roots[0]
  const terminal = evidence.terminalOrder
  if (
    roots.length !== 1 ||
    root === undefined ||
    terminal === undefined ||
    root.order.brokerOrderId !== terminal.brokerOrderId ||
    root.eventId !== terminal.eventId ||
    root.order.clientOrderId !== evidence.intent?.clientOrderId ||
    root.order.quantityAtoms !== terminal.quantityAtoms ||
    root.order.filledQuantityAtoms !== terminal.filledQuantityAtoms ||
    root.order.status !== terminal.status ||
    root.occurredAt !== terminal.occurredAt ||
    root.order.observedAt !== terminal.observedAt
  ) {
    fail('TERMINAL_ORDER_EVIDENCE_GAP')
    return { reasons: [...reasons], fills }
  }
  const receipt = (row: typeof root) => ({
    ...row,
    intentId: evidence.intentId,
    decisionId: evidence.decisionDocumentHash,
    authorityGenerationHash: native.authorityGenerationHash,
  })
  const children = native.orders.filter((row) => row !== root)
  const plan = {
    target: native.target,
    risk: { limitPriceMicros: native.limitPriceMicros, protection: native.protection },
    intentId: evidence.intentId,
    decisionId: evidence.decisionDocumentHash,
    document: { bindings: { accountId: evidence.accountId, authorityGenerationHash: native.authorityGenerationHash } },
  }
  for (const row of native.orders) {
    if (
      !/^[a-f0-9]{64}$/.test(row.eventId) ||
      !Schema.is(UtcInstantSchema)(row.occurredAt) ||
      row.occurredAt > row.order.observedAt ||
      row.order.observedAt > (input.reconciliation?.reconciledAt ?? '') ||
      row.occurredAt < evidence.decisionCreatedAt
    )
      fail('FILL_TIMESTAMP_GAP')
    const terms = resolveExecutionOrderTerms(row.order.brokerOrderId, receipt(root), children.map(receipt), plan)
    if (Result.isFailure(terms)) fail('FILL_IDENTITY_DRIFT')
    else if (terms.success._tag === 'Missing') fail('TERMINAL_ORDER_EVIDENCE_GAP')
  }
  const quantities = new Map<string, bigint>()
  for (const fill of fills) {
    const row = children.find((child) => child.order.brokerOrderId === fill.brokerOrderId)
    const order = row?.order
    if (
      order === undefined ||
      fill.accountId !== evidence.accountId ||
      fill.intentId !== evidence.intentId ||
      fill.symbol !== evidence.symbol ||
      fill.clientOrderId !== order.clientOrderId ||
      fill.side !== order.side
    )
      fail('FILL_IDENTITY_DRIFT')
    if (
      !/^[1-9][0-9]*$/.test(fill.quantityAtoms) ||
      !/^[1-9][0-9]*$/.test(fill.priceAtoms) ||
      !/^(0|[1-9][0-9]*)$/.test(fill.feeMicros) ||
      [fill.quantityAtoms, fill.priceAtoms, fill.feeMicros].some((value) => BigInt(value) > (1n << 127n) - 1n)
    ) {
      fail('INVALID_EXECUTION_MICROS')
      continue
    }
    const quantity = BigInt(fill.quantityAtoms)
    const limitAtoms = order?.limitPriceMicros === undefined ? undefined : BigInt(order.limitPriceMicros) * 1000n
    if (
      limitAtoms === undefined ||
      (fill.side === 'SELL' ? BigInt(fill.priceAtoms) < limitAtoms : BigInt(fill.priceAtoms) > limitAtoms)
    )
      fail('FILL_IDENTITY_DRIFT')
    quantities.set(fill.brokerOrderId, (quantities.get(fill.brokerOrderId) ?? 0n) + quantity)
    if (
      !/^[a-f0-9]{64}$/.test(fill.brokerEventId) ||
      (fill.sourceSequence !== undefined && !/^(0|[1-9][0-9]*)$/.test(fill.sourceSequence)) ||
      !Schema.is(UtcInstantSchema)(fill.occurredAt) ||
      !Schema.is(UtcInstantSchema)(fill.observedAt) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/.test(fill.sourceTimestamp) ||
      fill.occurredAt < evidence.decisionCreatedAt ||
      fill.observedAt < fill.occurredAt ||
      row === undefined ||
      fill.occurredAt > row.occurredAt ||
      fill.observedAt > (input.reconciliation?.reconciledAt ?? '')
    )
      fail('FILL_TIMESTAMP_GAP')
    const transaction = transactions.get(fill.brokerEventId)
    const notional = (quantity * BigInt(fill.priceAtoms) + 500_000_000_000n) / 1_000_000_000_000n
    if (
      transaction === undefined ||
      transaction.brokerEventId !== fill.brokerEventId ||
      transaction.intentId !== evidence.intentId ||
      transaction.cycleId !== evidence.cycleId ||
      transaction.symbol !== fill.symbol ||
      transaction.side !== fill.side ||
      transaction.quantityAtoms !== fill.quantityAtoms ||
      transaction.priceAtoms !== fill.priceAtoms ||
      transaction.feeMicros !== fill.feeMicros ||
      transaction.occurredAt !== fill.occurredAt ||
      transaction.notionalMicros !== notional.toString()
    )
      fail('ACCOUNTING_FILL_BINDING_GAP')
  }
  for (const { order } of children) {
    const quantity = quantities.get(order.brokerOrderId) ?? 0n
    if (
      quantity !== BigInt(order.filledQuantityAtoms) ||
      quantity > BigInt(order.quantityAtoms ?? '0') ||
      (order.status === OrderStatus.Filled && quantity !== BigInt(order.quantityAtoms ?? '0'))
    )
      fail('FILL_QUANTITY_MISMATCH')
    if (![OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected].includes(order.status))
      fail('TERMINAL_ORDER_EVIDENCE_GAP')
  }
  // Both children consume the same parent inventory, including fills that race cancellation.
  let inventory = isBracketProtection(native.protection) ? 0n : BigInt(native.target.quantityAtoms)
  for (const fill of [...evidence.fills, ...fills].toSorted(
    (a, b) =>
      a.sourceTimestamp.localeCompare(b.sourceTimestamp) ||
      (a.sourceSequence !== undefined &&
      b.sourceSequence !== undefined &&
      /^(0|[1-9][0-9]*)$/.test(a.sourceSequence) &&
      /^(0|[1-9][0-9]*)$/.test(b.sourceSequence)
        ? BigInt(a.sourceSequence) < BigInt(b.sourceSequence)
          ? -1
          : BigInt(a.sourceSequence) > BigInt(b.sourceSequence)
            ? 1
            : 0
        : 0) ||
      a.brokerEventId.localeCompare(b.brokerEventId),
  )) {
    if (!/^[1-9][0-9]*$/.test(fill.quantityAtoms)) continue
    if (isBracketProtection(native.protection) && fill.brokerOrderId === root.order.brokerOrderId)
      inventory += BigInt(fill.quantityAtoms)
    else inventory -= BigInt(fill.quantityAtoms)
    if (inventory < 0n) fail('FILL_QUANTITY_MISMATCH')
  }
  return { reasons: [...reasons], fills }
}
