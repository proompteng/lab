import { describe, expect, test } from 'bun:test'

import {
  AccountStatus,
  DiscrepancyKind,
  IntentState,
  OrderSide,
  OrderStatus,
  OrderType,
  TerminalOutcome,
  TimeInForce,
  type AccountSnapshot,
  type Fill,
  type Order,
  type Position,
  type Valuation,
} from './paper'
import { compareReconciliation, type ReconciliationSnapshot } from './reconciliation'

const hash = (value: string): string => value.repeat(64).slice(0, 64)
const observedAt = '2026-07-22T15:30:00.000Z'
const reconciledAt = '2026-07-22T15:30:01.000Z'

const account: AccountSnapshot = {
  schemaVersion: 'bayn.paper-account-snapshot.v1',
  accountId: 'paper-account',
  status: AccountStatus.Active,
  currency: 'USD',
  cashMicros: '900000000',
  equityMicros: '1000000000',
  buyingPowerMicros: '900000000',
  observedAt,
}

const position: Position = {
  schemaVersion: 'bayn.paper-position.v1',
  accountId: account.accountId,
  symbol: 'NVDA',
  quantityMicros: '1000000',
  averageEntryPriceMicros: '90000000',
  marketPriceMicros: '100000000',
  marketValueMicros: '100000000',
  unrealizedPnlMicros: '10000000',
  observedAt,
}

const order: Order = {
  schemaVersion: 'bayn.paper-order.v1',
  accountId: account.accountId,
  brokerOrderId: 'broker-order-1',
  clientOrderId: 'bayn-order-1',
  intentId: hash('1'),
  symbol: position.symbol,
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: position.quantityMicros,
  filledQuantityMicros: position.quantityMicros,
  status: OrderStatus.Filled,
  observedAt,
}

const fill: Fill = {
  schemaVersion: 'bayn.paper-fill.v1',
  accountId: account.accountId,
  fillId: 'fill-1',
  brokerOrderId: order.brokerOrderId,
  clientOrderId: order.clientOrderId,
  intentId: order.intentId,
  symbol: order.symbol,
  side: order.side,
  quantityMicros: order.quantityMicros,
  priceMicros: '90000000',
  feeMicros: '0',
  occurredAt: observedAt,
}

const valuation: Valuation = {
  schemaVersion: 'bayn.paper-valuation.v1',
  valuationId: hash('2'),
  accountId: account.accountId,
  sourceHash: hash('3'),
  cashMicros: account.cashMicros,
  longMarketValueMicros: position.marketValueMicros,
  shortMarketValueMicros: '0',
  equityMicros: account.equityMicros,
  asOf: observedAt,
}

const snapshot = (overrides: Partial<ReconciliationSnapshot> = {}): ReconciliationSnapshot => ({
  accountId: account.accountId,
  stateHash: hash('4'),
  account,
  positions: [position],
  orders: [order],
  fills: [fill],
  intents: [
    {
      intentId: order.intentId ?? hash('1'),
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      timeInForce: order.timeInForce,
      quantityMicros: order.quantityMicros,
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
      expectsBrokerOrder: true,
      brokerOrderId: order.brokerOrderId,
    },
  ],
  durableFills: [{ fillId: fill.fillId, brokerOrderId: fill.brokerOrderId, accounted: true }],
  projectedPositions: [
    { symbol: position.symbol, quantityMicros: position.quantityMicros, costBasisMicros: '90000000' },
  ],
  expectedCashMicros: account.cashMicros,
  valuation,
  accountingHash: hash('5'),
  ledgerExact: true,
  reconciledAt,
  ...overrides,
})

describe('paper reconciliation', () => {
  test('returns one exact hash for a completely reconciled state', () => {
    const result = compareReconciliation(snapshot())

    expect(result.expectedHash).toBe(hash('4'))
    expect(result.observedHash).toBe(result.expectedHash)
    expect(result.discrepancies).toEqual([])
    expect(result.metrics).toEqual({
      brokerPollAgeMs: 1_000,
      oldestUnknownMutationAgeMs: 0,
      cashDifferenceMicros: '0',
      positionDifferenceMicros: '0',
      equityDifferenceMicros: '0',
      accountingExact: true,
      discrepancyCount: 0,
    })
  })

  test('treats a restricted broker account as a blocking discrepancy', () => {
    const result = compareReconciliation(snapshot({ account: { ...account, status: AccountStatus.Restricted } }))

    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({
      kind: DiscrepancyKind.Account,
      expected: AccountStatus.Active,
      observed: AccountStatus.Restricted,
    })
  })

  test('reports every material mismatch with stable identities', () => {
    const externalOrder = { ...order, brokerOrderId: 'external-order', clientOrderId: 'external-client' }
    const input = snapshot({
      account: { ...account, cashMicros: '899000000', equityMicros: '998000000' },
      positions: [{ ...position, quantityMicros: '2000000' }],
      orders: [order, externalOrder],
      fills: [{ ...fill, fillId: 'missing-fill' }],
      intents: [
        {
          intentId: order.intentId ?? hash('1'),
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
          side: order.side,
          orderType: order.orderType,
          timeInForce: order.timeInForce,
          quantityMicros: order.quantityMicros,
          state: IntentState.Terminal,
          terminalOutcome: TerminalOutcome.Filled,
          expectsBrokerOrder: true,
          brokerOrderId: order.brokerOrderId,
          unknownSince: observedAt,
        },
      ],
      durableFills: [{ fillId: fill.fillId, brokerOrderId: fill.brokerOrderId, accounted: false }],
      ledgerExact: false,
    })

    const first = compareReconciliation(input)
    const second = compareReconciliation(input)
    const kinds = new Set(first.discrepancies.map((value) => value.kind))

    expect(first).toEqual(second)
    expect(first.observedHash).not.toBe(first.expectedHash)
    expect(kinds).toEqual(
      new Set([
        DiscrepancyKind.Order,
        DiscrepancyKind.Mutation,
        DiscrepancyKind.Fill,
        DiscrepancyKind.Accounting,
        DiscrepancyKind.Position,
        DiscrepancyKind.Cash,
        DiscrepancyKind.Valuation,
      ]),
    )
    expect(first.metrics).toMatchObject({
      cashDifferenceMicros: '-1000000',
      positionDifferenceMicros: '1000000',
      equityDifferenceMicros: '-2000000',
      accountingExact: false,
    })
    expect(new Set(first.discrepancies.map((value) => value.discrepancyId)).size).toBe(first.discrepancies.length)
  })

  test('detects a missing expected broker order', () => {
    const result = compareReconciliation(snapshot({ orders: [] }))

    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({
      kind: DiscrepancyKind.Order,
      identity: `${order.clientOrderId}:presence`,
      observed: '<absent>',
    })
  })

  test('detects a broker order before the intent expects one', () => {
    const input = snapshot()
    const result = compareReconciliation({
      ...input,
      intents: input.intents.map(({ brokerOrderId: _brokerOrderId, terminalOutcome: _terminalOutcome, ...intent }) => ({
        ...intent,
        state: IntentState.IoStarted,
        expectsBrokerOrder: false,
      })),
    })

    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({
      kind: DiscrepancyKind.Order,
      identity: `${order.clientOrderId}:presence`,
      expected: '<absent>',
      observed: order.brokerOrderId,
    })
  })

  test('detects broker position cost drift independently of quantity', () => {
    const result = compareReconciliation(
      snapshot({ positions: [{ ...position, averageEntryPriceMicros: '91000000' }] }),
    )

    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({
      kind: DiscrepancyKind.Position,
      identity: `${position.symbol}:cost`,
      expected: '90000000',
      observed: '91000000',
    })
  })

  test('keeps a ledger discrepancy identity stable while its evidence changes', () => {
    const first = compareReconciliation(snapshot({ ledgerExact: false, accountingHash: hash('a') }))
    const second = compareReconciliation(snapshot({ ledgerExact: false, accountingHash: hash('b') }))

    expect(first.discrepancies).toHaveLength(1)
    expect(second.discrepancies).toHaveLength(1)
    expect(first.discrepancies[0].discrepancyId).toBe(second.discrepancies[0].discrepancyId)
    expect(first.discrepancies[0].evidenceHash).not.toBe(second.discrepancies[0].evidenceHash)
  })

  test('compares the complete order contract, lifecycle, and aggregate fill quantity', () => {
    const result = compareReconciliation(
      snapshot({
        orders: [
          {
            ...order,
            orderType: OrderType.Limit,
            limitPriceMicros: '90000000',
            status: OrderStatus.PartiallyFilled,
            filledQuantityMicros: '500000',
          },
        ],
      }),
    )

    expect(new Set(result.discrepancies.map((value) => value.identity))).toEqual(
      new Set([
        `${order.clientOrderId}:content`,
        `${order.clientOrderId}:lifecycle`,
        `${order.brokerOrderId}:quantity`,
      ]),
    )
  })

  test('rejects duplicate broker identities before comparing', () => {
    expect(() => compareReconciliation(snapshot({ orders: [order, { ...order }] }))).toThrow(
      'duplicate broker client order ID',
    )
  })
})
