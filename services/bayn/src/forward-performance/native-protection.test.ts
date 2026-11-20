import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Result } from 'effect'
import { OrderSide, OrderStatus, OrderType, TimeInForce } from '../execution/contracts'
import { executionQualityFixture } from './execution-quality.test-support'
import { makeForwardPerformanceExecutionMeasurements } from './execution-quality'
import type { ForwardPerformanceExecutionEvidence } from './model'

const fixture = () => {
  const base = executionQualityFixture(1)
  const original = base.executionEvidence[0]
  assert(original !== undefined && original.intent !== undefined && original.terminalOrder !== undefined)
  const entry: ForwardPerformanceExecutionEvidence = {
    ...original,
    side: 'BUY',
    intent: { ...original.intent, side: 'BUY' },
    terminalOrder: { ...original.terminalOrder, side: 'BUY' },
    fills: original.fills.map((fill) => ({ ...fill, side: 'BUY' })),
  }
  const parent = entry.terminalOrder
  assert(parent !== undefined)
  const occurredAt = '2026-07-20T14:01:00.000Z'
  const observedAt = '2026-07-20T14:01:00.100Z'
  const root = {
    eventId: parent.eventId,
    occurredAt: parent.occurredAt,
    order: {
      schemaVersion: 'bayn.order.v3' as const,
      accountId: entry.accountId,
      brokerOrderId: parent.brokerOrderId,
      clientOrderId: parent.clientOrderId,
      intentId: entry.intentId,
      symbol: entry.symbol,
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '1000000000',
      filledQuantityAtoms: '1000000000',
      limitPriceMicros: '100000000',
      status: OrderStatus.Filled,
      observedAt: parent.observedAt,
    },
  }
  const profit = {
    eventId: 'b'.repeat(64),
    occurredAt,
    order: {
      ...root.order,
      brokerOrderId: 'profit',
      clientOrderId: 'profit-client',
      parentBrokerOrderId: parent.brokerOrderId,
      side: OrderSide.Sell,
      limitPriceMicros: '101000000',
      observedAt,
    },
  }
  const stop = {
    eventId: 'c'.repeat(64),
    occurredAt,
    order: {
      ...profit.order,
      brokerOrderId: 'stop',
      clientOrderId: 'stop-client',
      orderType: OrderType.StopLimit,
      filledQuantityAtoms: '0',
      limitPriceMicros: '98500000',
      stopPriceMicros: '99000000',
      status: OrderStatus.Canceled,
    },
  }
  const originalFill = entry.fills[0]
  assert(originalFill !== undefined)
  const fill = {
    ...originalFill,
    brokerEventId: 'd'.repeat(64),
    fillId: 'protective-fill',
    brokerOrderId: 'profit',
    clientOrderId: 'profit-client',
    side: 'SELL' as const,
    priceAtoms: '101000000000',
    occurredAt,
    observedAt,
    sourceTimestamp: '2026-07-20T14:01:00.000000000Z',
  }
  const native: NonNullable<ForwardPerformanceExecutionEvidence['nativeProtection']> = {
    schemaVersion: 'bayn.forward-performance-native-protection.v1',
    target: {
      symbol: entry.symbol,
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '1000000000',
    },
    limitPriceMicros: '100000000',
    authorityGenerationHash: 'e'.repeat(64),
    protection: {
      _tag: 'Bracket',
      stopPriceMicros: '99000000',
      stopLimitPriceMicros: '98500000',
      profitLimitPriceMicros: '101000000',
    },
    orders: [root, profit, stop],
    fills: [fill],
  }
  const input = {
    ...base,
    executionEvidence: [{ ...entry, nativeProtection: native }],
    reconciliation: {
      ...base.reconciliation,
      reconciliationId: 'f'.repeat(64),
      contentHash: 'a'.repeat(64),
      status: 'EXACT' as const,
      performanceExact: true,
      cashYieldAdjustedExact: false,
      reconciledAt: '2026-07-20T14:02:00.000Z',
    },
    transactions: [
      ...base.transactions.map((transaction) => ({ ...transaction, side: 'BUY' as const })),
      {
        ...base.transactions[0],
        transactionId: '9'.repeat(64),
        brokerEventId: fill.brokerEventId,
        intentId: entry.intentId,
        cycleId: entry.cycleId,
        symbol: entry.symbol,
        side: 'SELL' as const,
        quantityAtoms: fill.quantityAtoms,
        priceAtoms: fill.priceAtoms,
        feeMicros: fill.feeMicros,
        realizedPnlMicros: '1000000',
        occurredAt,
        notionalMicros: '101000000',
      },
    ],
  }
  return input
}
const measure = (input: ReturnType<typeof fixture>) =>
  Result.getOrThrow(makeForwardPerformanceExecutionMeasurements(input))

test('native bracket fills retain exact parent/child and accounting identities without inventing a conditional benchmark', () => {
  const input = fixture()
  const result = measure(input)
  assert.deepEqual(result.executionQuality.reasonCodes, ['PROTECTIVE_REFERENCE_PRICE_EVIDENCE_GAP'])
  assert.equal(result.diagnostics.evaluatedFillCount, 2)
  assert.equal(result.executionQuality.implementationShortfall, null)
  const execution = input.executionEvidence[0]
  assert(execution !== undefined)
  assert.deepEqual(
    measure({
      ...input,
      executionEvidence: [
        {
          ...execution,
          nativeProtection: {
            ...execution.nativeProtection,
            orders: execution.nativeProtection.orders.toReversed(),
            fills: execution.nativeProtection.fills.toReversed(),
          },
        },
      ],
      transactions: input.transactions.toReversed(),
    }),
    result,
  )
})

test('a pre-submission block does not require broker protection receipts, but cannot hide actual orders', () => {
  const input = fixture()
  const execution = input.executionEvidence[0]
  assert(execution !== undefined && execution.intent !== undefined)
  const { terminalOrder: _terminal, nativeProtection, ...rest } = execution
  const blocked: ForwardPerformanceExecutionEvidence = {
    ...rest,
    intent: { ...execution.intent, terminalOutcome: 'BLOCKED' },
    fills: [],
  }
  const source = { ...input, transactions: [], executionEvidence: [blocked] }
  const baseline = Result.getOrThrow(makeForwardPerformanceExecutionMeasurements(source))
  const projected = Result.getOrThrow(
    makeForwardPerformanceExecutionMeasurements({
      ...source,
      executionEvidence: [{ ...blocked, nativeProtection: { ...nativeProtection, orders: [], fills: [] } }],
    }),
  )
  assert.deepEqual(projected.executionQuality.reasonCodes, baseline.executionQuality.reasonCodes)
  for (const unexpectedNative of [
    { ...nativeProtection, fills: [] },
    { ...nativeProtection, orders: [] },
  ]) {
    const unexpected = Result.getOrThrow(
      makeForwardPerformanceExecutionMeasurements({
        ...source,
        executionEvidence: [{ ...blocked, nativeProtection: unexpectedNative }],
      }),
    )
    assert(unexpected.executionQuality.reasonCodes.includes('TERMINAL_ORDER_EVIDENCE_GAP'))
  }
})

test.each(['parent', 'price', 'side', 'account', 'quantity', 'accounting', 'cutoff', 'missing'] as const)(
  'native protective evidence rejects %s corruption',
  (kind) => {
    const input = structuredClone(fixture())
    const execution = input.executionEvidence[0]
    assert(execution !== undefined)
    const native = execution.nativeProtection
    const profit = native.orders.find((row) => row.order.brokerOrderId === 'profit')
    assert(profit !== undefined)
    const changed = {
      ...profit.order,
      ...(kind === 'parent' ? { parentBrokerOrderId: 'unrelated' } : {}),
      ...(kind === 'price' ? { limitPriceMicros: '102000000' } : {}),
      ...(kind === 'side' ? { side: OrderSide.Buy } : {}),
      ...(kind === 'account' ? { accountId: 'another-account' } : {}),
      ...(kind === 'quantity' ? { filledQuantityAtoms: '2000000000' } : {}),
      ...(kind === 'cutoff' ? { observedAt: '2026-07-20T14:03:00.000Z' } : {}),
    }
    const result = measure({
      ...input,
      executionEvidence: [
        {
          ...execution,
          nativeProtection: {
            ...native,
            orders: native.orders
              .filter((row) => kind !== 'missing' || row !== profit)
              .map((row) => (row === profit ? { ...row, order: changed } : row)),
          },
        },
      ],
      transactions: input.transactions.map((row) =>
        kind === 'accounting' && row.side === 'SELL' ? { ...row, notionalMicros: '1' } : row,
      ),
    })
    assert(result.executionQuality.reasonCodes.some((reason) => reason !== 'PROTECTIVE_REFERENCE_PRICE_EVIDENCE_GAP'))
  },
)
test('a cancellation race retains partial protective fills and charges', () => {
  const input = fixture()
  const execution = input.executionEvidence[0]
  assert(execution !== undefined)
  const result = measure({
    ...input,
    openPositionCount: 1,
    executionEvidence: [
      {
        ...execution,
        nativeProtection: {
          ...execution.nativeProtection,
          fills: execution.nativeProtection.fills.map((fill) => ({ ...fill, quantityAtoms: '400000000' })),
          orders: execution.nativeProtection.orders.map((row) =>
            row.order.brokerOrderId === 'profit'
              ? { ...row, order: { ...row.order, filledQuantityAtoms: '400000000', status: OrderStatus.Canceled } }
              : row,
          ),
        },
      },
    ],
    transactions: input.transactions.map((row) =>
      row.side === 'SELL' ? { ...row, quantityAtoms: '400000000', notionalMicros: '40400000' } : row,
    ),
  })
  assert.deepEqual(result.executionQuality.reasonCodes, ['PROTECTIVE_REFERENCE_PRICE_EVIDENCE_GAP'])
  assert.equal(result.diagnostics.evaluatedFillCount, 2)
})

test('both partial protective legs consume one parent inventory and retain their fees', () => {
  const input = fixture()
  assert(input.ledgerTotals !== undefined)
  const execution = input.executionEvidence[0]
  assert(execution !== undefined)
  const native = execution.nativeProtection
  const profitFill = native.fills[0]
  const transaction = input.transactions.find((row) => row.side === 'SELL')
  assert(profitFill !== undefined && transaction !== undefined)
  const stopFill = {
    ...profitFill,
    brokerEventId: '6'.repeat(64),
    fillId: 'stop-fill',
    brokerOrderId: 'stop',
    clientOrderId: 'stop-client',
    quantityAtoms: '600000000',
    priceAtoms: '98500000000',
    feeMicros: '7',
  }
  const result = measure({
    ...input,
    ledgerTotals: { ...input.ledgerTotals, brokerExecutionFeesMicros: '7' },
    transactions: [
      ...input.transactions.map((row) =>
        row.side === 'SELL' ? { ...row, quantityAtoms: '400000000', notionalMicros: '40400000' } : row,
      ),
      {
        ...transaction,
        transactionId: '7'.repeat(64),
        brokerEventId: stopFill.brokerEventId,
        quantityAtoms: stopFill.quantityAtoms,
        priceAtoms: stopFill.priceAtoms,
        feeMicros: '7',
        notionalMicros: '59100000',
      },
    ],
    executionEvidence: [
      {
        ...execution,
        nativeProtection: {
          ...native,
          fills: [{ ...profitFill, quantityAtoms: '400000000' }, stopFill],
          orders: native.orders.map((row) =>
            row.order.brokerOrderId === 'profit'
              ? { ...row, order: { ...row.order, filledQuantityAtoms: '400000000', status: OrderStatus.Canceled } }
              : row.order.brokerOrderId === 'stop'
                ? {
                    ...row,
                    order: {
                      ...row.order,
                      quantityAtoms: '600000000',
                      filledQuantityAtoms: '600000000',
                      status: OrderStatus.Filled,
                    },
                  }
                : row,
          ),
        },
      },
    ],
  })
  assert.deepEqual(result.executionQuality.reasonCodes, ['PROTECTIVE_REFERENCE_PRICE_EVIDENCE_GAP'])
  assert.equal(result.diagnostics.evaluatedFillCount, 3)
})
