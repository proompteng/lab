import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'
import fc from 'fast-check'
import { checkProperty } from './testing/property-test-support'

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
} from './execution/contracts'
import type { AccountingTransaction } from './accounting/schema'
import { prepareAccounting } from './accounting/domain'
import { positionCostAnchor } from './reconciliation/position-cost-reporting'
import { compareReconciliation } from './simulation-reconciliation/broker-compare'
import {
  reconciledStateHash,
  renderReconciliationDecisionError,
  type ReconciliationDecisionError,
  type ReconciliationSnapshot,
} from './simulation-reconciliation/broker-model'

const successOf = <A>(result: Result.Result<A, ReconciliationDecisionError>): A => Result.getOrThrow(result)
const failureOf = <A>(result: Result.Result<A, ReconciliationDecisionError>): ReconciliationDecisionError => {
  if (Result.isFailure(result)) return result.failure
  return expect.unreachable('expected reconciliation decision failure')
}

const hash = (value: string): string => value.repeat(64).slice(0, 64)
const observedAt = '2026-07-22T15:30:00.000Z'
const reconciledAt = '2026-07-22T15:30:01.000Z'

const account: AccountSnapshot = {
  schemaVersion: 'bayn.paper-account-snapshot.v2',
  cryptoFeeTier: null,
  accountId: 'paper-account',
  status: AccountStatus.Active,
  currency: 'USD',
  cashMicros: '900000000',
  equityMicros: '1000000000',
  buyingPowerMicros: '900000000',
  observedAt,
}

const position: Position = {
  schemaVersion: 'bayn.position.v2',
  costBasisMicros: '90000000',
  accountId: account.accountId,
  symbol: 'NVDA',
  quantityAtoms: '1000000000',
  averageEntryPriceMicros: '90000000',
  marketPriceMicros: '100000000',
  marketValueMicros: '100000000',
  unrealizedPnlMicros: '10000000',
  observedAt,
}

const order: Order = {
  schemaVersion: 'bayn.order.v3',
  accountId: account.accountId,
  brokerOrderId: 'broker-order-1',
  clientOrderId: 'bayn-order-1',
  intentId: hash('1'),
  symbol: position.symbol,
  side: OrderSide.Buy,
  orderType: OrderType.Limit,
  limitPriceMicros: '100000000',
  timeInForce: TimeInForce.Day,
  quantityAtoms: position.quantityAtoms,
  filledQuantityAtoms: position.quantityAtoms,
  status: OrderStatus.Filled,
  observedAt,
}

const fill: Fill = {
  schemaVersion: 'bayn.fill.v2',
  accountId: account.accountId,
  fillId: 'fill-1',
  brokerOrderId: order.brokerOrderId,
  clientOrderId: order.clientOrderId,
  ...(order.intentId === undefined ? {} : { intentId: order.intentId }),
  symbol: order.symbol,
  side: order.side,
  quantityAtoms: position.quantityAtoms,
  priceAtoms: '90000000000',
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
      submittedQuantityAtoms: position.quantityAtoms,
      ...(order.limitPriceMicros === undefined ? {} : { submittedLimitPriceMicros: order.limitPriceMicros }),
      timeInForce: order.timeInForce,
      quantityAtoms: position.quantityAtoms,
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
      expectsBrokerOrder: true,
      brokerOrderId: order.brokerOrderId,
    },
  ],
  durableFills: [{ fillId: fill.fillId, brokerOrderId: fill.brokerOrderId, accounted: true }],
  projectedPositions: [
    {
      costBasisAnchor: null,
      symbol: position.symbol,
      quantityAtoms: position.quantityAtoms,
      costBasisMicros: '90000000',
    },
  ],
  expectedCashMicros: account.cashMicros,
  valuation,
  accountingHash: hash('5'),
  ledgerExact: true,
  reconciledAt,
  ...overrides,
})

describe('execution reconciliation', () => {
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
    const { quantityAtoms: _omittedOrderQuantity, limitPriceMicros: _omittedLimitPrice, ...currentOrderBase } = order
    const currentOrder: Order = {
      ...currentOrderBase,
      schemaVersion: 'bayn.order.v3',
      orderType: OrderType.Market,
      notionalMicros: '100000000',
    }
    const [legacyIntent] = snapshot().intents
    if (legacyIntent === undefined) throw new Error('expected reconciliation intent fixture')
    const {
      submittedLimitPriceMicros: _omittedSubmittedLimitPrice,
      submittedQuantityAtoms: _omittedSubmittedQuantity,
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
      positions: [{ ...position, quantityAtoms: '2000000000' }],
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
          quantityAtoms: position.quantityAtoms,
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
      ]),
    )
    expect(first.metrics).toMatchObject({
      cashDifferenceMicros: '-1000000',
      positionDifferenceMicros: '1000000000',
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
      compareReconciliation(
        snapshot({ positions: [{ ...position, averageEntryPriceMicros: '91000000', costBasisMicros: '91000000' }] }),
      ),
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
          positions: [{ ...position, quantityAtoms: '500000000', averageEntryPriceMicros: '1', costBasisMicros: '1' }],
          projectedPositions: [
            { costBasisAnchor: null, symbol: position.symbol, quantityAtoms: '500000000', costBasisMicros: '0' },
          ],
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

  test('reproduces rounded-average broker position reporting from exact NVDA fill cost', () => {
    const positions: Position[] = [
      {
        ...position,
        schemaVersion: 'bayn.position.v2',
        quantityAtoms: '91000000000',
        averageEntryPriceMicros: '217158242',
        costBasisMicros: '19761400022',
      },
    ]
    const input = snapshot({
      positions,
      projectedPositions: [
        { costBasisAnchor: null, symbol: 'NVDA', quantityAtoms: '91000000000', costBasisMicros: '19761400000' },
      ],
    })
    expect(successOf(compareReconciliation(input)).discrepancies).toEqual([])
    for (const costBasisMicros of ['19761400021', '19761400023', '19761400100']) {
      expect(
        successOf(
          compareReconciliation({
            ...input,
            positions: [
              {
                ...positions[0],
                ...position,
                schemaVersion: 'bayn.position.v2',
                quantityAtoms: '91000000000',
                averageEntryPriceMicros: '217158242',
                costBasisMicros,
              },
            ],
          }),
        ).discrepancies.some(({ identity }) => identity === 'NVDA:cost'),
      ).toBe(true)
    }
    expect(
      successOf(
        compareReconciliation({
          ...input,
          projectedPositions: [
            { costBasisAnchor: null, symbol: 'NVDA', quantityAtoms: '91000000000', costBasisMicros: '19761400100' },
          ],
        }),
      ).discrepancies.some(({ identity }) => identity === 'NVDA:cost'),
    ).toBe(true)
  })

  test('reproduces sequentially rounded equity fills without a cost or quantity tolerance', () => {
    const transactions: AccountingTransaction[] = []
    let lot = { quantityAtoms: '0', costMicros: '0' }
    const record = (quantity: bigint, price: bigint, side: OrderSide) => {
      const index = transactions.length
      const prepared = Result.getOrThrow(
        prepareAccounting(
          hash(String(index)),
          {
            ...fill,
            symbol: 'QQQ',
            side,
            fillId: `equity-fill-${index}`,
            quantityAtoms: String(quantity * 1_000_000_000n),
            priceAtoms: String(price),
            occurredAt: `2026-07-22T15:29:0${index}.000Z`,
          },
          lot,
          1,
        ),
      )
      transactions.push(prepared.transaction)
      lot = {
        quantityAtoms: String(BigInt(lot.quantityAtoms) + BigInt(prepared.transaction.quantityDeltaAtoms)),
        costMicros: String(BigInt(lot.costMicros) + BigInt(prepared.transaction.costBasisDeltaMicros)),
      }
    }
    for (const [quantity, price] of [
      [4n, 692130000000n],
      [13n, 692070000000n],
      [7n, 692090000000n],
      [2n, 692050000000n],
      [1n, 692030000000n],
    ] as const)
      record(quantity, price, OrderSide.Buy)
    const projected = { symbol: 'QQQ', quantityAtoms: lot.quantityAtoms, costBasisMicros: lot.costMicros }
    expect(projected).toEqual({ symbol: 'QQQ', quantityAtoms: '27000000000', costBasisMicros: '18686190000' })
    const observed: Position = {
      ...position,
      symbol: 'QQQ',
      quantityAtoms: projected.quantityAtoms,
      averageEntryPriceMicros: '692081112',
      costBasisMicros: '18686190024',
    }
    const input = snapshot({
      positions: [observed],
      orders: [],
      fills: [],
      intents: [],
      durableFills: [],
      projectedPositions: [
        {
          ...projected,
          costBasisAnchor: positionCostAnchor(account.accountId, projected, transactions, [], observedAt),
        },
      ],
    })
    expect(successOf(compareReconciliation(input)).discrepancies).toEqual([])
    for (const changed of [
      { ...observed, costBasisMicros: '18686190023' },
      { ...observed, costBasisMicros: '18686190025' },
      { ...observed, averageEntryPriceMicros: '692081113' },
      { ...observed, quantityAtoms: '27000000001' },
    ])
      expect(successOf(compareReconciliation({ ...input, positions: [changed] })).discrepancies.length).toBeGreaterThan(
        0,
      )
    expect(positionCostAnchor(account.accountId, projected, transactions.slice(1), [], observedAt)).toBeNull()
    expect(
      positionCostAnchor(
        account.accountId,
        { ...projected, costBasisMicros: '18686190001' },
        transactions,
        [],
        observedAt,
      ),
    ).toBeNull()
    expect(positionCostAnchor(account.accountId, projected, transactions, [], '2026-07-23T15:30:00.000Z')).toBeNull()
    expect(positionCostAnchor(account.accountId, projected, transactions, [], '2026-07-22T15:29:02.000Z')).toBeNull()
    record(6n, 692420000000n, OrderSide.Sell)
    const partial = { ...projected, quantityAtoms: lot.quantityAtoms, costBasisMicros: lot.costMicros }
    expect(partial).toMatchObject({ quantityAtoms: '21000000000', costBasisMicros: '14533703333' })
    const partialAnchor = positionCostAnchor(account.accountId, partial, transactions, [], observedAt)
    expect(
      successOf(
        compareReconciliation({
          ...input,
          positions: [{ ...observed, quantityAtoms: partial.quantityAtoms, costBasisMicros: '14533703352' }],
          projectedPositions: [{ ...partial, costBasisAnchor: partialAnchor }],
        }),
      ).discrepancies,
    ).toEqual([])
    record(21n, 692420000000n, OrderSide.Sell)
    record(2n, 100000000000n, OrderSide.Buy)
    expect(
      positionCostAnchor(
        account.accountId,
        { ...projected, quantityAtoms: lot.quantityAtoms, costBasisMicros: lot.costMicros },
        transactions,
        [],
        observedAt,
      ),
    ).toEqual({ priceAtomsNumerator: '100000000000', priceAtomsDenominator: '1' })
  })

  test('property: rounded-average position reporting rejects unrelated basis and quantity changes', () => {
    checkProperty(
      'position-cost-reporting',
      fc.property(
        fc.bigInt({ min: 1_000_000_000n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: 1_000_000n, max: 1_000_000_000_000n }),
        (quantity, cost) => {
          const price = (cost * 1_000_000_000n * 2n + quantity) / (quantity * 2n)
          const reportedCost = (quantity * price + 500_000_000n) / 1_000_000_000n
          const observed: Position = {
            ...position,
            quantityAtoms: String(quantity),
            averageEntryPriceMicros: String(price),
            costBasisMicros: String(reportedCost),
          }
          const input = snapshot({
            positions: [observed],
            projectedPositions: [
              {
                costBasisAnchor: null,
                symbol: position.symbol,
                quantityAtoms: String(quantity),
                costBasisMicros: String(cost),
              },
            ],
          })
          expect(successOf(compareReconciliation(input)).discrepancies).toEqual([])
          const changedCost = reportedCost + (reportedCost === cost - 1n ? 2n : 1n)
          expect(
            successOf(
              compareReconciliation({
                ...input,
                positions: [{ ...observed, costBasisMicros: String(changedCost) }],
              }),
            ).discrepancies.some(({ identity }) => identity === 'NVDA:cost'),
          ).toBe(true)
          expect(
            successOf(
              compareReconciliation({
                ...input,
                positions: [{ ...observed, quantityAtoms: String(quantity + 1n) }],
              }),
            ).discrepancies.some(({ identity }) => identity === 'NVDA:quantity'),
          ).toBe(true)
        },
      ),
    )
  })

  test('uses broker cost basis without reconstructing it from rounded average entry price', () => {
    const input = snapshot({
      positions: [
        {
          ...position,
          schemaVersion: 'bayn.position.v2',
          quantityAtoms: '3000000000',
          averageEntryPriceMicros: '100333333',
          costBasisMicros: '301000000',
        },
      ],
      projectedPositions: [
        { costBasisAnchor: null, symbol: position.symbol, quantityAtoms: '3000000000', costBasisMicros: '301000000' },
      ],
    })
    expect(successOf(compareReconciliation(input)).discrepancies).toEqual([])
    const drift = successOf(
      compareReconciliation({
        ...input,
        positions: [
          {
            ...position,
            schemaVersion: 'bayn.position.v2',
            quantityAtoms: '3000000000',
            averageEntryPriceMicros: '100333333',
            costBasisMicros: '301000001',
          },
        ],
      }),
    )
    expect(drift.discrepancies).toHaveLength(1)
    expect(drift.discrepancies[0]).toMatchObject({
      identity: `${position.symbol}:cost`,
      expected: '301000000',
      observed: '301000001',
    })
  })

  test('preserves reconciliation output above U128 and its exact evidence hashes', () => {
    const quantityAtoms = '170141183460469231731687303715884105727'
    const result = successOf(
      compareReconciliation(
        snapshot({
          positions: [
            {
              ...position,
              quantityAtoms,
              averageEntryPriceMicros: '340282366920938463463374607431768211455',
              costBasisMicros: '57896044618658097711785492504343953926124568782438874324533730092809',
            },
          ],
          projectedPositions: [{ costBasisAnchor: null, symbol: position.symbol, quantityAtoms, costBasisMicros: '0' }],
        }),
      ),
    )

    expect(result.observedHash).toBe('6aee902d58b45b8a15fd40771ac2afc2cde5518393ef3a182bd619b010acff4a')
    expect(result.discrepancies).toEqual([
      {
        discrepancyId: '82d8cf06a2c0300ed87632447e51b5fc7b03ac37eeb87df44e46edea3a0af96b',
        kind: DiscrepancyKind.Position,
        identity: `${position.symbol}:cost`,
        expected: '0',
        observed: '57896044618658097711785492504343953926124568782438874324533730092809',
        evidenceHash: 'e63710ca9e2d9710238c379c3657b34595100ab3a2de6eacb8a2a6c42672859e',
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

  test('accepts an accounted broker fill before the acknowledged intent is terminalized', () => {
    const current = snapshot()
    const intents = current.intents.map(({ terminalOutcome: _terminalOutcome, ...intent }) => ({
      ...intent,
      state: IntentState.Acknowledged,
    }))

    expect(successOf(compareReconciliation({ ...current, intents })).discrepancies).toEqual([])
    expect(
      successOf(compareReconciliation({ ...current, intents, durableFills: [] })).discrepancies.length,
    ).toBeGreaterThan(0)
  })

  test.each([observedAt, '2026-07-22T15:30:00.002Z'])(
    'reports independent equity marks even when receipt timestamps coincide: %s',
    (positionObservedAt) => {
      const result = successOf(
        compareReconciliation(
          snapshot({
            account: { ...account, equityMicros: '1000170000' },
            positions: [{ ...position, observedAt: positionObservedAt }],
          }),
        ),
      )

      expect(result.discrepancies).toEqual([])
      expect(result.metrics.equityDifferenceMicros).toBe('170000')
      const flat = successOf(
        compareReconciliation(snapshot({ positions: [], valuation: { ...valuation, equityMicros: '0' } })),
      )
      expect(flat.discrepancies.some(({ kind }) => kind === DiscrepancyKind.Valuation)).toBe(true)
    },
  )

  test('compares the complete order contract, lifecycle, and aggregate fill quantity', () => {
    const result = successOf(
      compareReconciliation(
        snapshot({
          orders: [
            {
              ...order,
              limitPriceMicros: '90000000',
              status: OrderStatus.PartiallyFilled,
              filledQuantityAtoms: '500000000',
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
