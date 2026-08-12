import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

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
import {
  compareReconciliation,
  reconciledStateHash,
  renderReconciliationDecisionError,
  type ReconciliationDecisionError,
  type ReconciliationSnapshot,
} from './reconciliation'

const successOf = <A>(result: Result.Result<A, ReconciliationDecisionError>): A => Result.getOrThrow(result)
const failureOf = <A>(result: Result.Result<A, ReconciliationDecisionError>): ReconciliationDecisionError => {
  if (Result.isFailure(result)) return result.failure
  return expect.unreachable('expected reconciliation decision failure')
}

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
  orderType: OrderType.Limit,
  limitPriceMicros: '100000000',
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
  ...(order.intentId === undefined ? {} : { intentId: order.intentId }),
  symbol: order.symbol,
  side: order.side,
  quantityMicros: position.quantityMicros,
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
      orderType: OrderType.Market,
      submittedOrderType: OrderType.Limit,
      submittedQuantityMicros: position.quantityMicros,
      ...(order.limitPriceMicros === undefined ? {} : { submittedLimitPriceMicros: order.limitPriceMicros }),
      timeInForce: order.timeInForce,
      quantityMicros: position.quantityMicros,
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
    const result = successOf(compareReconciliation(snapshot()))

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

  test('reconciles the exact notional MARKET representation used by current BUY submissions', () => {
    const { quantityMicros: _omittedOrderQuantity, limitPriceMicros: _omittedLimitPrice, ...currentOrderBase } = order
    const currentOrder: Order = {
      ...currentOrderBase,
      schemaVersion: 'bayn.paper-order.v2',
      orderType: OrderType.Market,
      notionalMicros: '100000000',
    }
    const [legacyIntent] = snapshot().intents
    if (legacyIntent === undefined) throw new Error('expected reconciliation intent fixture')
    const {
      submittedLimitPriceMicros: _omittedSubmittedLimitPrice,
      submittedQuantityMicros: _omittedSubmittedQuantity,
      ...currentIntentBase
    } = legacyIntent
    const result = successOf(
      compareReconciliation(
        snapshot({
          orders: [currentOrder],
          intents: [
            {
              ...currentIntentBase,
              submittedOrderType: OrderType.Market,
              submittedNotionalMicros: '100000000',
            },
          ],
        }),
      ),
    )

    expect(result.discrepancies).toEqual([])
    expect(result.observedHash).toBe(result.expectedHash)
  })

  test('treats a restricted broker account as a blocking discrepancy', () => {
    const result = successOf(
      compareReconciliation(snapshot({ account: { ...account, status: AccountStatus.Restricted } })),
    )

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
          orderType: OrderType.Market,
          submittedOrderType: OrderType.Limit,
          ...(order.limitPriceMicros === undefined ? {} : { submittedLimitPriceMicros: order.limitPriceMicros }),
          timeInForce: order.timeInForce,
          quantityMicros: position.quantityMicros,
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

    const first = successOf(compareReconciliation(input))
    const second = successOf(compareReconciliation(input))
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
    const result = successOf(compareReconciliation(snapshot({ orders: [] })))

    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({
      kind: DiscrepancyKind.Order,
      identity: `${order.clientOrderId}:presence`,
      observed: '<absent>',
    })
  })

  test('detects a broker order before the intent expects one', () => {
    const input = snapshot()
    const result = successOf(
      compareReconciliation({
        ...input,
        intents: input.intents.map(
          ({ brokerOrderId: _brokerOrderId, terminalOutcome: _terminalOutcome, ...intent }) => ({
            ...intent,
            state: IntentState.IoStarted,
            expectsBrokerOrder: false,
          }),
        ),
      }),
    )

    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({
      kind: DiscrepancyKind.Order,
      identity: `${order.clientOrderId}:presence`,
      expected: '<absent>',
      observed: order.brokerOrderId,
    })
  })

  test('detects broker position cost drift independently of quantity', () => {
    const result = successOf(
      compareReconciliation(snapshot({ positions: [{ ...position, averageEntryPriceMicros: '91000000' }] })),
    )

    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({
      kind: DiscrepancyKind.Position,
      identity: `${position.symbol}:cost`,
      expected: '90000000',
      observed: '91000000',
    })
  })

  test('preserves exact-half position cost discrepancy identities and hashes', () => {
    const result = successOf(
      compareReconciliation(
        snapshot({
          positions: [{ ...position, quantityMicros: '500000', averageEntryPriceMicros: '1' }],
          projectedPositions: [{ symbol: position.symbol, quantityMicros: '500000', costBasisMicros: '0' }],
        }),
      ),
    )

    expect(result.observedHash).toBe('eddcbffe34a93edb13621d0f3b4a29b4530550fe0947da942bb11cf46d649c91')
    expect(result.discrepancies).toEqual([
      {
        discrepancyId: '82d8cf06a2c0300ed87632447e51b5fc7b03ac37eeb87df44e46edea3a0af96b',
        kind: DiscrepancyKind.Position,
        identity: `${position.symbol}:cost`,
        expected: '0',
        observed: '1',
        evidenceHash: 'bc9bfb97cb8744667e423365862a52d76046a352ee1398ee82274f0c2a07783d',
      },
    ])
  })

  test('preserves reconciliation output above U128 and its exact evidence hashes', () => {
    const quantityMicros = '170141183460469231731687303715884105727'
    const result = successOf(
      compareReconciliation(
        snapshot({
          positions: [
            {
              ...position,
              quantityMicros,
              averageEntryPriceMicros: '340282366920938463463374607431768211455',
            },
          ],
          projectedPositions: [{ symbol: position.symbol, quantityMicros, costBasisMicros: '0' }],
        }),
      ),
    )

    expect(result.observedHash).toBe('7d475d168ec5d130dbc08418eb200deef0775f8ab8339c453e3016a2d3caa7f1')
    expect(result.discrepancies).toEqual([
      {
        discrepancyId: '82d8cf06a2c0300ed87632447e51b5fc7b03ac37eeb87df44e46edea3a0af96b',
        kind: DiscrepancyKind.Position,
        identity: `${position.symbol}:cost`,
        expected: '0',
        observed: '57896044618658097711785492504343953926124568782438874324533730092808913',
        evidenceHash: '937546e66a02272e1b3bbc238fdf84721746ebd04d30f6de5deae0627ad0bafd',
      },
    ])
  })

  test('keeps a ledger discrepancy identity stable while its evidence changes', () => {
    const first = successOf(compareReconciliation(snapshot({ ledgerExact: false, accountingHash: hash('a') })))
    const second = successOf(compareReconciliation(snapshot({ ledgerExact: false, accountingHash: hash('b') })))

    expect(first.discrepancies).toHaveLength(1)
    expect(second.discrepancies).toHaveLength(1)
    expect(first.discrepancies[0].discrepancyId).toBe(second.discrepancies[0].discrepancyId)
    expect(first.discrepancies[0].evidenceHash).not.toBe(second.discrepancies[0].evidenceHash)
  })

  test('compares the complete order contract, lifecycle, and aggregate fill quantity', () => {
    const result = successOf(
      compareReconciliation(
        snapshot({
          orders: [
            {
              ...order,
              limitPriceMicros: '90000000',
              status: OrderStatus.PartiallyFilled,
              filledQuantityMicros: '500000',
            },
          ],
        }),
      ),
    )

    expect(new Set(result.discrepancies.map((value) => value.identity))).toEqual(
      new Set([
        `${order.clientOrderId}:content`,
        `${order.clientOrderId}:lifecycle`,
        `${order.brokerOrderId}:quantity`,
      ]),
    )
  })

  test('preserves exact historical MARKET broker orders', () => {
    const input = snapshot()
    const result = successOf(
      compareReconciliation({
        ...input,
        orders: [
          (({ limitPriceMicros: _limitPriceMicros, ...marketOrder }) => ({
            ...marketOrder,
            orderType: OrderType.Market,
          }))(order),
        ],
        intents: input.intents.map(({ submittedLimitPriceMicros: _limit, ...intent }) => ({
          ...intent,
          submittedOrderType: OrderType.Market,
        })),
      }),
    )

    expect(result.discrepancies).toEqual([])
  })

  test('returns fact-bearing failures for account, timestamp, integer, and canonicalization defects', () => {
    expect(failureOf(compareReconciliation(snapshot({ orders: [{ ...order, accountId: 'other-account' }] })))).toEqual({
      _tag: 'AccountBindingMismatch',
      source: 'order',
      identity: order.brokerOrderId,
      expectedAccountId: account.accountId,
      observedAccountId: 'other-account',
    })
    expect(failureOf(compareReconciliation(snapshot({ reconciledAt: 'not-an-instant' })))).toEqual({
      _tag: 'InvalidInstant',
      field: 'reconciledAt',
      identity: account.accountId,
      value: 'not-an-instant',
    })
    expect(failureOf(compareReconciliation(snapshot({ expectedCashMicros: 'not-an-integer' })))).toEqual({
      _tag: 'InvalidInteger',
      source: 'expected-cash',
      identity: account.accountId,
      value: 'not-an-integer',
    })
    expect(failureOf(compareReconciliation(snapshot({ expectedCashMicros: '+1' })))).toEqual({
      _tag: 'InvalidInteger',
      source: 'expected-cash',
      identity: account.accountId,
      value: '+1',
    })
    const canonicalization = failureOf(
      reconciledStateHash({
        account: { ...account, accountId: '\ud800' },
        positions: [position],
        positionsObservedAt: observedAt,
        orders: [order],
        ordersObservedAt: observedAt,
        accountingHash: hash('5'),
      }),
    )
    expect(canonicalization).toMatchObject({
      _tag: 'CanonicalizationFailed',
      operation: 'broker-state-hash',
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.account.accountId',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      },
    })
    expect(renderReconciliationDecisionError(canonicalization)).toBe(
      'reconciliation broker-state-hash canonicalization failed',
    )
  })

  test('rejects duplicate broker identities before comparing', () => {
    const error = failureOf(compareReconciliation(snapshot({ orders: [order, { ...order }] })))

    expect(error).toEqual({
      _tag: 'DuplicateIdentity',
      collection: 'broker-client-order',
      identity: order.clientOrderId,
    })
    expect(renderReconciliationDecisionError(error)).toBe(
      `duplicate broker-client-order identity ${order.clientOrderId}`,
    )
  })
})
