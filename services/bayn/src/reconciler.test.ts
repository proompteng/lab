import { describe, expect, test } from 'bun:test'

import { Deferred, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import {
  AccountStatus as BrokerAccountStatus,
  AssetClass,
  OrderClass,
  OrderSide as BrokerSide,
  OrderStatus as BrokerOrderStatus,
  OrderType as BrokerOrderType,
  TimeInForce as BrokerTimeInForce,
  TradeActivityType,
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  type Account as BrokerAccount,
  type BrokerReadShape,
  type FillActivity,
  type Order as BrokerOrder,
  type ReadEvidence,
} from './broker/alpaca'
import { unusedMarketCalendar } from './broker/alpaca-test-support'
import { canonicalHashV1 } from './hash'
import { ReconciliationStatus, type AccountingReceipt, type Valuation } from './paper'
import { PaperStore, type PaperStoreShape } from './db/paper-store'
import type { BrokerSnapshot, ReconciliationWriteResult } from './db/reconciliation'
import { WriterFence, type WriterFenceService } from './execution/writer-fence'
import { ReconciliationError, runContinuously, runOnce } from './reconciler'
import { reconciledStateHash } from './reconciliation'

const accountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const observedAt = '1970-01-01T00:00:00.000Z'
const hash = (value: unknown): string => canonicalHashV1(value)

const evidence = (identity: string): ReadEvidence => ({
  requestId: `request-${identity}`,
  status: 200,
  contentHash: hash(identity),
  observedAt,
})

const account: BrokerAccount = {
  id: accountId,
  status: BrokerAccountStatus.Active,
  currency: 'USD',
  cashMicros: '1000000000',
  equityMicros: '1000000000',
  buyingPowerMicros: '2000000000',
  accountBlocked: false,
  tradingBlocked: false,
  tradeSuspendedByUser: false,
  observedAt,
}

const order = (index: number): BrokerOrder => ({
  accountId,
  brokerOrderId: `broker-order-${index}`,
  clientOrderId: `client-order-${index}`,
  createdAt: observedAt,
  updatedAt: observedAt,
  submittedAt: new Date(index).toISOString(),
  assetId: `asset-${index}`,
  symbol: 'NVDA',
  assetClass: AssetClass.UsEquity,
  quantityMicros: '1000000',
  filledQuantityMicros: '1000000',
  filledAveragePriceMicros: '100000000',
  orderClass: OrderClass.Simple,
  orderType: BrokerOrderType.Market,
  side: BrokerSide.Buy,
  timeInForce: BrokerTimeInForce.Day,
  status: BrokerOrderStatus.Filled,
  extendedHours: false,
  observedAt,
})

const fill = (index: number, sourceOrder = order(index)): FillActivity => ({
  accountId,
  activityId: `fill-${index}`,
  cumulativeQuantityMicros: '1000000',
  leavesQuantityMicros: '0',
  priceMicros: '100000000',
  quantityMicros: '1000000',
  side: sourceOrder.side,
  symbol: sourceOrder.symbol,
  transactionTime: observedAt,
  brokerOrderId: sourceOrder.brokerOrderId,
  type: TradeActivityType.Fill,
  orderStatus: BrokerOrderStatus.Filled,
})

const valuation: Valuation = {
  schemaVersion: 'bayn.paper-valuation.v1',
  valuationId: hash('valuation'),
  accountId,
  sourceHash: hash('valuation-source'),
  cashMicros: account.cashMicros,
  longMarketValueMicros: '0',
  shortMarketValueMicros: '0',
  equityMicros: account.cashMicros,
  asOf: observedAt,
}

const receipt: AccountingReceipt = {
  schemaVersion: 'bayn.paper-accounting-receipt.v1',
  receiptId: hash('receipt'),
  brokerEventId: hash('fill-event'),
  tigerBeetleClusterId: '1',
  tigerBeetleLedger: 1,
  accountIds: ['1', '2'],
  transferIds: ['3'],
  debitMicros: '1',
  creditMicros: '1',
  contentHash: hash('receipt-content'),
  recordedAt: observedAt,
}

const report = (snapshot: BrokerSnapshot): ReconciliationWriteResult => {
  const accountingHash = hash('accounting-state')
  const stateHash = reconciledStateHash({
    account: snapshot.account,
    positions: snapshot.positions,
    positionsObservedAt: snapshot.positionsObservedAt,
    orders: snapshot.orders,
    ordersObservedAt: snapshot.ordersObservedAt,
    accountingHash,
  })
  return {
    reconciliation: {
      schemaVersion: 'bayn.paper-reconciliation.v1',
      reconciliationId: hash('reconciliation'),
      accountId,
      expectedHash: stateHash,
      observedHash: stateHash,
      contentHash: hash('reconciliation-content'),
      status: ReconciliationStatus.Exact,
      discrepancies: [],
      reconciledAt: snapshot.reconciledAt,
    },
    metrics: {
      brokerPollAgeMs: 0,
      oldestUnknownMutationAgeMs: 0,
      cashDifferenceMicros: '0',
      positionDifferenceMicros: '0',
      equityDifferenceMicros: '0',
      accountingExact: true,
      discrepancyCount: 0,
    },
    accountingHash,
    riskContext: {
      tradingDate: '1969-12-31',
      authority: null,
      authorityObservedAt: null,
      unknownMutationCount: 0,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: snapshot.account.equityMicros,
      peakEquityMicros: snapshot.account.equityMicros,
    },
  }
}

interface StoreControl {
  writes: number
  reconciliations: BrokerSnapshot[]
  restrictions: string[]
}

const makeStore = (control: StoreControl, hasAccountBaseline = true): PaperStoreShape => ({
  ingest: (input) =>
    Effect.sync(() => {
      control.writes += 1
      return { eventId: hash(input.sourceEventId), sourceSequence: String(control.writes), deduplicated: false }
    }),
  ingestPositions: (input) =>
    Effect.sync(() => {
      control.writes += 1
      return { snapshotId: hash(input.sourceHash), eventIds: [], deduplicated: false }
    }),
  account: () =>
    Effect.sync(() => {
      control.writes += 1
      return receipt
    }),
  value: () =>
    Effect.sync(() => {
      control.writes += 1
      return valuation
    }),
  hasAccountBaseline: () => Effect.succeed(hasAccountBaseline),
  bindings: () => Effect.succeed([{ intentId: hash('intent'), clientOrderId: order(0).clientOrderId }]),
  reconcile: (snapshot) =>
    Effect.sync(() => {
      control.writes += 1
      control.reconciliations.push(snapshot)
      return report(snapshot)
    }),
  ensureAuthorityGeneration: () => Effect.die(new Error('unexpected authority generation initialization')),
  restrictAuthority: (reason) =>
    Effect.sync(() => {
      control.restrictions.push(reason)
    }),
})

const emptyRead = (): BrokerReadShape => ({
  account: Effect.succeed({ value: account, evidence: evidence('account') }),
  positions: Effect.succeed({ value: [], evidence: evidence('positions') }),
  orders: () => Effect.succeed({ value: [], evidence: evidence('orders') }),
  fillActivities: () => Effect.succeed({ value: { items: [] }, evidence: evidence('fills') }),
  orderById: () => Effect.die(new Error('unexpected order lookup')),
  orderByClientId: () => Effect.die(new Error('unexpected client order lookup')),
  marketCalendar: unusedMarketCalendar,
})

const fence: WriterFenceService = {
  backendPid: 1,
  check: Effect.void,
  transaction: (effect) => effect,
}

const provide = (read: BrokerReadShape, store: PaperStoreShape) =>
  runOnce.pipe(
    Effect.provideService(BrokerRead, read),
    Effect.provideService(PaperStore, store),
    Effect.provideService(WriterFence, fence),
  )

describe('paper reconciliation loop', () => {
  test('reads every broker page before persisting and binds fills to their orders', async () => {
    const allOrders = Array.from({ length: 501 }, (_, index) => order(index))
    const allFills = Array.from({ length: 101 }, (_, index) => fill(index, allOrders[index]))
    const orderCursors: Array<string | undefined> = []
    const fillCursors: Array<string | undefined> = []
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: (query = {}) => {
        orderCursors.push(query.after)
        return Effect.succeed({
          value: query.after === undefined ? allOrders.slice(0, 500) : allOrders.slice(500),
          evidence: evidence(`orders-${orderCursors.length}`),
        })
      },
      fillActivities: (query = {}) => {
        fillCursors.push(query.pageToken)
        const items = query.pageToken === undefined ? allFills.slice(0, 100) : allFills.slice(100)
        return Effect.succeed({
          value: {
            items,
            ...(query.pageToken === undefined ? { nextPageToken: allFills[99].activityId } : {}),
          },
          evidence: evidence(`fills-${fillCursors.length}`),
        })
      },
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const result = await Effect.runPromise(provide(read, makeStore(control)))

    expect(orderCursors).toEqual([undefined, allOrders[499].submittedAt, undefined, allOrders[499].submittedAt])
    expect(fillCursors).toEqual([undefined, allFills[99].activityId, undefined, allFills[99].activityId])
    expect(control.reconciliations).toHaveLength(1)
    expect(control.reconciliations[0].orders).toHaveLength(501)
    expect(control.reconciliations[0].fills).toHaveLength(101)
    expect(control.reconciliations[0].orders[0].intentId).toBe(hash('intent'))
    expect(control.reconciliations[0].fills[0].intentId).toBe(hash('intent'))
    expect(result.brokerState.orders.map((candidate) => candidate.brokerOrderId)).toEqual(
      allOrders.map((candidate) => candidate.brokerOrderId).sort(),
    )
    expect(result.brokerState.unknownOrderCount).toBe(500)
    const stateHash = reconciledStateHash(result.brokerState)
    expect(result.report.reconciliation.expectedHash).toBe(stateHash)
    expect(result.report.reconciliation.observedHash).toBe(stateHash)
    expect(result.brokerState.reconciliation).toEqual(result.report.reconciliation)
    expect(result.riskContext).toMatchObject({
      authority: null,
      authorityObservedAt: null,
      unknownMutationCount: 0,
    })
    expect(control.restrictions).toEqual([])
  })

  test('rejects historical fills on an uninitialized account before ingesting broker state', async () => {
    const existingOrder = order(0)
    const existingFill = fill(0, existingOrder)
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: () => Effect.succeed({ value: [existingOrder], evidence: evidence('orders') }),
      fillActivities: () => Effect.succeed({ value: { items: [existingFill] }, evidence: evidence('fills') }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const failure = await Effect.runPromise(provide(read, makeStore(control, false)).pipe(Effect.flip))

    expect(failure).toMatchObject({
      _tag: 'ReconciliationError',
      operation: 'snapshot',
      message: 'paper account has fill history before Bayn established an opening cash baseline',
    })
    expect(control.writes).toBe(0)
    expect(control.reconciliations).toEqual([])
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('orders fills by normalized instants before accounting', async () => {
    const earlierOrder = { ...order(0), submittedAt: '2026-07-22T12:00:00.000Z' }
    const laterOrder = { ...order(1), submittedAt: '2026-07-22T12:00:01.000Z' }
    const earlierFill = {
      ...fill(0, earlierOrder),
      activityId: 'fill-z',
      transactionTime: '2026-07-22T12:00:00.1Z',
    }
    const laterFill = {
      ...fill(1, laterOrder),
      activityId: 'fill-a',
      transactionTime: '2026-07-22T12:00:00.100001Z',
    }
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: () => Effect.succeed({ value: [earlierOrder, laterOrder], evidence: evidence('orders') }),
      fillActivities: () => Effect.succeed({ value: { items: [laterFill, earlierFill] }, evidence: evidence('fills') }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    await Effect.runPromise(provide(read, makeStore(control)))

    expect(control.reconciliations).toHaveLength(1)
    expect(control.reconciliations[0].fills.map((candidate) => candidate.fillId)).toEqual([
      earlierFill.activityId,
      laterFill.activityId,
    ])
  })

  test('fails a duplicate page before any durable write or false resolution', async () => {
    const duplicate = fill(0)
    const read: BrokerReadShape = {
      ...emptyRead(),
      fillActivities: () =>
        Effect.succeed({
          value: { items: [duplicate], nextPageToken: duplicate.activityId },
          evidence: evidence('duplicate-fill'),
        }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const failure = await Effect.runPromise(provide(read, makeStore(control)).pipe(Effect.flip))
    expect(failure).toBeInstanceOf(ReconciliationError)
    expect(control.writes).toBe(0)
    expect(control.reconciliations).toEqual([])
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('rejects a broker mutation that races the account snapshot before any durable write', async () => {
    const racedOrder = order(0)
    const racedFill = fill(0, racedOrder)
    let orderReads = 0
    let fillReads = 0
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: () => {
        orderReads += 1
        return Effect.succeed({
          value: orderReads === 1 ? [] : [racedOrder],
          evidence: evidence(`orders-${orderReads}`),
        })
      },
      fillActivities: () => {
        fillReads += 1
        return Effect.succeed({
          value: { items: fillReads === 1 ? [] : [racedFill] },
          evidence: evidence(`fills-${fillReads}`),
        })
      },
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const failure = await Effect.runPromise(provide(read, makeStore(control)).pipe(Effect.flip))

    expect(failure).toMatchObject({
      _tag: 'ReconciliationError',
      operation: 'snapshot',
      message: 'broker history changed during reconciliation',
    })
    expect(orderReads).toBe(2)
    expect(fillReads).toBe(2)
    expect(control.writes).toBe(0)
    expect(control.reconciliations).toEqual([])
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('rejects broker history beyond the hard row limit before persisting', async () => {
    let offset = 0
    const read: BrokerReadShape = {
      ...emptyRead(),
      fillActivities: (query = {}) => {
        const pageSize = query.pageSize ?? 100
        const items = Array.from({ length: pageSize }, (_, index) => fill(offset + index))
        offset += items.length
        return Effect.succeed({
          value: { items, nextPageToken: items[items.length - 1]?.activityId },
          evidence: evidence(`fill-page-${offset}`),
        })
      },
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const failure = await Effect.runPromise(provide(read, makeStore(control)).pipe(Effect.flip))
    expect(failure).toMatchObject({
      _tag: 'ReconciliationError',
      operation: 'pagination',
      message: 'Alpaca fill history exceeds 10000 rows',
    })
    expect(offset).toBe(10_001)
    expect(control.writes).toBe(0)
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('runs immediately and repeats on the Effect schedule', async () => {
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* runContinuously(100).pipe(
          Effect.provideService(BrokerRead, emptyRead()),
          Effect.provideService(PaperStore, makeStore(control)),
          Effect.provideService(WriterFence, fence),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Effect.yieldNow
        expect(control.reconciliations).toHaveLength(1)
        yield* TestClock.adjust(99)
        expect(control.reconciliations).toHaveLength(1)
        yield* TestClock.adjust(1)
        expect(control.reconciliations).toHaveLength(2)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('restricts authority after a failed pass and retries on the same scoped loop', async () => {
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    let attempts = 0
    const read: BrokerReadShape = {
      ...emptyRead(),
      account: Effect.suspend(() => {
        attempts += 1
        return attempts === 1
          ? Effect.fail(
              new BrokerReadError({
                operation: 'account',
                kind: BrokerReadErrorKind.Transport,
                message: 'injected read failure',
                retryable: true,
              }),
            )
          : Effect.succeed({ value: account, evidence: evidence('account') })
      }),
    }
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* runContinuously(100).pipe(
          Effect.provideService(BrokerRead, read),
          Effect.provideService(PaperStore, makeStore(control)),
          Effect.provideService(WriterFence, fence),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Effect.yieldNow
        expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
        expect(control.reconciliations).toEqual([])
        yield* TestClock.adjust(100)
        expect(control.reconciliations).toHaveLength(1)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('interrupts an in-flight read on shutdown without treating shutdown as a failed pass', async () => {
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    const program = Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const read: BrokerReadShape = {
          ...emptyRead(),
          account: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        }
        const fiber = yield* provide(read, makeStore(control)).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
      }),
    )

    await Effect.runPromise(program)
    expect(control.writes).toBe(0)
    expect(control.restrictions).toEqual([])
  })
})
