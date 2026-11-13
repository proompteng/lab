import { beforeAll, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { OrderSide, OrderStatus, OrderType, TimeInForce } from '../execution/contracts'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { persistenceDocumentFixture } from '../system-assessment/decision-persistence.test-support'
import { bracketEvidenceFixture } from '../system-assessment/bracket-evidence.test-support'
import { testHash } from '../system-assessment/fixtures.test-support'
import { executionQualityFixture } from './execution-quality.test-support'
import { makeForwardPerformanceExecutionMeasurements } from './execution-quality'
import { executionEvidenceFromRows, indexExecutionEvidence, verifyPerformanceDecisions } from './postgres/projection'
import type { ForwardPerformanceEvidenceInput, ForwardPerformanceExecutionEvidence } from './model'

let document: ExecutionDecisionDocument
beforeAll(async () => {
  document = await Effect.runPromise(persistenceDocumentFixture)
})

const fixture = () => {
  const f = bracketEvidenceFixture(document)
  const { parent } = f
  const base = executionQualityFixture(1)
  const target = document.targetPlan.intentTargets[0]!
  const intentId = document.orderedIntentIds[0]!
  const orderRows = f.cut.orders.map(({ eventId, occurredAt, order }) => ({
    event_id: eventId,
    occurred_at: new Date(occurredAt),
    observed_at: new Date(order.observedAt),
    broker_order_id: order.brokerOrderId,
    parent_broker_order_id: order.parentBrokerOrderId ?? null,
    client_order_id: order.clientOrderId,
    intent_id: intentId,
    account_id: order.accountId,
    symbol: order.symbol,
    side: order.side,
    order_type: order.orderType,
    time_in_force: order.timeInForce,
    quantity_atoms: order.quantityAtoms ?? null,
    notional_micros: order.notionalMicros ?? null,
    limit_price_micros: order.limitPriceMicros ?? null,
    stop_price_micros: order.stopPriceMicros ?? null,
    filled_quantity_atoms: order.filledQuantityAtoms,
    status: order.status,
  }))
  const fillRows = f.cut.fills.map((fill) => ({
    event_id: testHash(fill.fillId),
    fill_id: fill.fillId,
    broker_order_id: fill.brokerOrderId,
    client_order_id: f.cut.orders.find(({ order }) => order.brokerOrderId === fill.brokerOrderId)!.order.clientOrderId,
    intent_id: intentId,
    account_id: parent.accountId,
    symbol: parent.symbol,
    side: fill.side,
    quantity_atoms: fill.quantityAtoms,
    price_atoms: fill.priceAtoms,
    fee_micros: '17',
    source_timestamp: fill.occurredAt.replace('Z', '000000Z'),
    source_sequence: fill.sourceSequence,
    occurred_at: new Date(fill.occurredAt),
    observed_at: new Date(f.at(9000)),
  }))
  const intent = {
    intent_id: intentId,
    account_id: parent.accountId,
    client_order_id: parent.clientOrderId,
    cycle_id: document.bindings.cycleId,
    decision_hash: document.bindings.strategyDecisionHash,
    symbol: parent.symbol,
    side: parent.side,
    quantity_atoms: target.quantityAtoms,
    notional_limit_micros: document.deltaRisk[0]!.notionalLimitMicros,
    replan_generation_hash: document.replanGenerationHash ?? null,
    terminal_outcome: 'FILLED' as const,
    created_at: new Date(document.createdAt),
    updated_at: new Date(parent.observedAt),
  }
  const verified = verifyPerformanceDecisions([
    {
      cycle_id: document.bindings.cycleId,
      decision_hash: document.contentHash,
      created_at: new Date(document.createdAt),
      document,
    },
  ])
  expect(verified.unverifiedDecisionHashes).toEqual([])
  const evidence = executionEvidenceFromRows(
    verified.verifiedRows,
    indexExecutionEvidence([intent], orderRows, fillRows),
  )
  const input: ForwardPerformanceEvidenceInput = {
    ...base,
    account: { ...base.account, accountId: parent.accountId },
    cycles: [{ ...base.cycles[0]!, cycleId: document.bindings.cycleId, accountId: parent.accountId }],
    executionEvidence: evidence,
    transactions: fillRows.map((fill) => ({
      transactionId: testHash({ transaction: fill.event_id }),
      brokerEventId: fill.event_id,
      intentId,
      cycleId: document.bindings.cycleId,
      symbol: fill.symbol,
      side: fill.side,
      quantityAtoms: fill.quantity_atoms,
      priceAtoms: fill.price_atoms,
      notionalMicros: (
        (BigInt(fill.quantity_atoms) * BigInt(fill.price_atoms) + 500_000_000_000n) /
        1_000_000_000_000n
      ).toString(),
      feeMicros: fill.fee_micros,
      realizedPnlMicros: '0',
      occurredAt: fill.occurred_at.toISOString(),
    })),
    reconciliation: { ...base.reconciliation!, reconciledAt: f.at(10000) },
    ledgerTotals: { ...base.ledgerTotals!, brokerExecutionFeesMicros: '68' },
  }
  return { input, evidence: evidence[0]!, orderRows, intent, fillRows, verified }
}

const measure = (input: ForwardPerformanceEvidenceInput) =>
  Result.getOrThrow(makeForwardPerformanceExecutionMeasurements(input))

test('projects BUY parent and protective SELLs with explicit native ownership and exact accounting costs', () => {
  const { input, evidence } = fixture()
  expect(evidence.terminalOrder?.brokerOrderId).toBe('native-parent')
  expect(evidence.nativeProtection?.orders).toHaveLength(3)
  expect(evidence.intent?.side).toBe('BUY')
  expect(evidence.fills.map((fill) => fill.side)).toEqual(['BUY', 'BUY', 'SELL', 'SELL'])
  const result = measure(input)
  expect(result.executionQuality.reasonCodes).toEqual([])
  expect(result.executionQuality.status).toBe('MEASURED')
  expect(result.diagnostics.nativeProtection).toEqual({
    inputGroupCount: 1,
    boundGroupCount: 1,
    childOrderCount: 2,
    evaluatedChildFillCount: 2,
  })
  expect(result.executionQuality.implementationShortfall).toMatchObject({
    fillCount: 4,
    explicitCostsMicros: '68',
    opportunityShortfallMicros: '0',
  })
  expect(result.executionQuality.implementationShortfall?.executedNotionalMicros).toBe(
    input.transactions.reduce((sum, row) => sum + BigInt(row.notionalMicros!), 0n).toString(),
  )
  // The take-profit is partially filled then canceled while the resized stop fills the remainder.
  expect(evidence.nativeProtection?.orders[1]?.order.status).toBe(OrderStatus.Canceled)
  expect(evidence.nativeProtection?.orders[2]?.order.status).toBe(OrderStatus.Filled)
})

test.each([
  [
    'sealed intent',
    (e: ForwardPerformanceExecutionEvidence) => ({
      ...e,
      nativeProtection: { ...e.nativeProtection!, intentId: 'a'.repeat(64) },
    }),
  ],
  [
    'missing sibling',
    (e: ForwardPerformanceExecutionEvidence) => ({
      ...e,
      nativeProtection: { ...e.nativeProtection!, orders: e.nativeProtection!.orders.slice(0, 2) },
    }),
  ],
  [
    'missing protection',
    (e: ForwardPerformanceExecutionEvidence) => {
      const { nativeProtection: _, ...rest } = e
      return rest
    },
  ],
  [
    'source ordering',
    (e: ForwardPerformanceExecutionEvidence) => ({
      ...e,
      fills: e.fills.map((fill) => ({ ...fill, sourceSequence: '1' })),
    }),
  ],
  [
    'chronological oversell',
    (e: ForwardPerformanceExecutionEvidence) => ({
      ...e,
      fills: e.fills.map((fill) =>
        fill.side === 'SELL' ? { ...fill, sourceTimestamp: document.createdAt.replace('Z', '000000Z') } : fill,
      ),
    }),
  ],
] as const)('rejects %s without removing protective transactions or their costs', (_, change) => {
  const { input, evidence } = fixture()
  const before = structuredClone(input.transactions)
  const result = measure({ ...input, executionEvidence: [change(evidence)] })
  expect(result.executionQuality.status).toBe('UNDETERMINED')
  expect(result.executionQuality.implementationShortfall).toBeNull()
  expect(input.transactions).toEqual(before)
})

test.each([
  { parentBrokerOrderId: 'unrelated-parent' },
  { accountId: 'other-account' },
  { symbol: 'OTHER' },
  { intentId: 'a'.repeat(64) },
  { side: OrderSide.Buy },
  { orderType: OrderType.Market },
  { timeInForce: TimeInForce.GoodUntilCanceled },
  { limitPriceMicros: '1' },
  { stopPriceMicros: '1' },
  { clientOrderId: 'native-parent-client' },
  { brokerOrderId: 'native-parent' },
  { quantityAtoms: '1' },
  { status: OrderStatus.New },
  { observedAt: '2099-01-01T00:00:00.000Z' },
])('rejects corrupted protective order %j', (change) => {
  const { input, evidence } = fixture()
  const native = evidence.nativeProtection!
  const orders = native.orders.map((receipt, index) =>
    index === 2 ? { ...receipt, order: { ...receipt.order, ...change } } : receipt,
  )
  const result = measure({ ...input, executionEvidence: [{ ...evidence, nativeProtection: { ...native, orders } }] })
  expect(result.executionQuality.status).toBe('UNDETERMINED')
  expect(result.executionQuality.reasonCodes).toContain('PROTECTION_EVIDENCE_GAP')
})

test('keeps all three orders even when the last observed event belongs to a child; duplicate roots stay ambiguous', () => {
  const f = fixture()
  const index = indexExecutionEvidence([f.intent], f.orderRows.toReversed(), f.fillRows.toReversed())
  const [evidence] = executionEvidenceFromRows(f.verified.verifiedRows, index)
  expect(evidence?.terminalOrder?.brokerOrderId).toBe('native-parent')
  expect(measure({ ...f.input, executionEvidence: [evidence!] })).toEqual(measure(f.input))
  const duplicate = indexExecutionEvidence([f.intent], [...f.orderRows, f.orderRows[0]!], f.fillRows)
  const bad = executionEvidenceFromRows(f.verified.verifiedRows, duplicate)
  expect(bad[0]?.terminalOrder).toBeUndefined()
  expect(measure({ ...f.input, executionEvidence: bad }).executionQuality.status).toBe('UNDETERMINED')
})

test.each(['clientOrderId', 'brokerOrderId', 'intentId', 'accountId', 'symbol'] as const)(
  'rejects protective fill %s corruption rather than accepting the shared BUY intent',
  (field) => {
    const { input, evidence } = fixture()
    const fills = evidence.fills.map((fill, index) => (index === 2 ? { ...fill, [field]: 'f'.repeat(64) } : fill))
    expect(measure({ ...input, executionEvidence: [{ ...evidence, fills }] }).executionQuality.status).toBe(
      'UNDETERMINED',
    )
  },
)

test('missing or changed protective accounting and excluded SELL fees cannot produce measured execution', () => {
  const { input } = fixture()
  for (const changed of [
    { ...input, transactions: input.transactions.filter((row) => row.side !== 'SELL') },
    {
      ...input,
      transactions: input.transactions.map((row) => (row.side === 'SELL' ? { ...row, side: 'BUY' as const } : row)),
    },
    { ...input, ledgerTotals: { ...input.ledgerTotals!, brokerExecutionFeesMicros: '34' } },
  ])
    expect(measure(changed).executionQuality.status).toBe('UNDETERMINED')
})

const withAccounting = (input: ForwardPerformanceEvidenceInput, evidence: ForwardPerformanceExecutionEvidence) => ({
  ...input,
  executionEvidence: [evidence],
  transactions: evidence.fills.map((fill) => ({
    ...input.transactions.find((row) => row.brokerEventId === fill.brokerEventId)!,
    side: fill.side,
    quantityAtoms: fill.quantityAtoms,
    priceAtoms: fill.priceAtoms,
    occurredAt: fill.occurredAt,
    notionalMicros: (
      (BigInt(fill.quantityAtoms) * BigInt(fill.priceAtoms) + 500_000_000_000n) /
      1_000_000_000_000n
    ).toString(),
  })),
  ledgerTotals: { ...input.ledgerTotals!, brokerExecutionFeesMicros: String(evidence.fills.length * 17) },
})

test('a partially filled then canceled parent bounds combined child disposals without waiving its missing terminal price', () => {
  const { input, evidence } = fixture()
  const native = evidence.nativeProtection!
  const partial: ForwardPerformanceExecutionEvidence = {
    ...evidence,
    intent: { ...evidence.intent!, terminalOutcome: 'CANCELED' },
    terminalOrder: { ...evidence.terminalOrder!, status: 'CANCELED', filledQuantityAtoms: '1000000000' },
    nativeProtection: {
      ...native,
      orders: native.orders.map((receipt, index) => ({
        ...receipt,
        order: {
          ...receipt.order,
          ...(index === 0
            ? { status: OrderStatus.Canceled, filledQuantityAtoms: '1000000000' }
            : { filledQuantityAtoms: '500000000', ...(index === 2 ? { quantityAtoms: '500000000' } : {}) }),
        },
      })),
    },
    fills: evidence.fills
      .filter((_, index) => index !== 1)
      .map((fill) => (fill.side === 'SELL' ? { ...fill, quantityAtoms: '500000000' } : fill)),
  }
  const result = measure(withAccounting(input, partial))
  expect(result.executionQuality.reasonCodes).toEqual(['TERMINAL_PRICE_EVIDENCE_GAP'])
  expect(result.diagnostics.evaluatedFillCount).toBe(3)
  const oversold = {
    ...partial,
    fills: partial.fills.map((fill, index) => (index === 2 ? { ...fill, quantityAtoms: '500000001' } : fill)),
  }
  expect(measure(withAccounting(input, oversold)).executionQuality.reasonCodes).toContain('PROTECTION_EVIDENCE_GAP')
})

test('a canceled unfilled protective sibling adds neither a hypothetical trade nor an opportunity shortfall', () => {
  const { input, evidence } = fixture()
  const native = evidence.nativeProtection!
  const quantity = evidence.plannedQuantityAtoms!
  const changed: ForwardPerformanceExecutionEvidence = {
    ...evidence,
    nativeProtection: {
      ...native,
      orders: native.orders.map((receipt, index) => ({
        ...receipt,
        order: {
          ...receipt.order,
          ...(index === 1
            ? { filledQuantityAtoms: '0' }
            : index === 2
              ? { quantityAtoms: quantity, filledQuantityAtoms: quantity }
              : {}),
        },
      })),
    },
    fills: evidence.fills
      .filter((_, index) => index !== 2)
      .map((fill) => (fill.side === 'SELL' ? { ...fill, quantityAtoms: quantity } : fill)),
  }
  const result = measure(withAccounting(input, changed))
  expect(result.executionQuality.reasonCodes).toEqual([])
  expect(result.executionQuality.implementationShortfall).toMatchObject({
    fillCount: 3,
    explicitCostsMicros: '51',
    unfilledQuantityAtoms: '0',
    opportunityShortfallMicros: '0',
  })
})

test('equal source timestamps use the native sequence, not hash order, and inconsistent source clocks are rejected', () => {
  const { input, evidence } = fixture()
  const occurredAt = evidence.fills[0]!.occurredAt
  const fills = evidence.fills
    .map((fill) => ({ ...fill, occurredAt, sourceTimestamp: occurredAt.replace('Z', '000000Z') }))
    .toReversed()
  const changed = { ...evidence, fills }
  expect(measure(withAccounting(input, changed)).executionQuality.status).toBe('MEASURED')
  const wrong = {
    ...changed,
    fills: fills.map((fill) => (fill.side === 'SELL' ? { ...fill, sourceSequence: '0' } : fill)),
  }
  expect(measure(withAccounting(input, wrong)).executionQuality.reasonCodes).toContain('PROTECTION_EVIDENCE_GAP')
  const inconsistent = {
    ...changed,
    fills: fills.map((fill) => ({ ...fill, sourceTimestamp: '2026-01-01T00:00:00.000000000Z' })),
  }
  expect(measure(withAccounting(input, inconsistent)).executionQuality.reasonCodes).toContain('PROTECTION_EVIDENCE_GAP')
})

test('cost-matched fills below the sealed protective limit are still invalid execution evidence', () => {
  const { input, evidence } = fixture()
  const changed = {
    ...evidence,
    fills: evidence.fills.map((fill) => (fill.side === 'SELL' ? { ...fill, priceAtoms: '1' } : fill)),
  }
  expect(measure(withAccounting(input, changed)).executionQuality.reasonCodes).toContain('PROTECTION_EVIDENCE_GAP')
})
