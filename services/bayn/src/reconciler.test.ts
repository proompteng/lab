import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Exit, Fiber, HashSet, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from './effect-test-support'
import { accountTradingDate, currentUtcInstant, utcInstantFromEpochMillis } from './time'
import { IsoDateSchema } from './schemas'

import {
  AccountStatus as BrokerAccountStatus,
  AssetClass,
  OrderClass,
  OrderSide as BrokerSide,
  OrderStatus as BrokerOrderStatus,
  OrderType as BrokerOrderType,
  TimeInForce as BrokerTimeInForce,
  SortDirection,
  TradeActivityType,
  BrokerRead,
  type Account as BrokerAccount,
  type BrokerReadShape,
  type FillActivity,
  type Order as BrokerOrder,
  type ReadEvidence,
} from './broker/alpaca/model'
import { BrokerReadError, BrokerReadErrorKind } from './broker/alpaca/failures'
import { unusedAssetBySymbol, unusedMarketCalendar } from './broker/alpaca-test-support'
import { verifyProtectionGroup } from './broker/alpaca/protection-group'
import { canonicalHashV1Result } from './hash'
import { ReconciliationStatus, type AccountingReceipt, type Valuation } from './execution/contracts'
import {
  BrokerEventStore,
  AuthorityRestrictionStore,
  ExecutionStoreError,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
  type BrokerEventStoreShape,
  type AuthorityRestrictionStoreShape,
  type FillAccountingStoreShape,
  type ReconciliationStoreShape,
  type ValuationStoreShape,
} from './db/execution-store'
import type { BrokerSnapshot, ReconciliationWriteResult } from './db/reconciliation'
import { WriterFence, type WriterFenceService } from './execution/writer-fence'
import { ReconciliationClock, ReconciliationError, runOnce } from './reconciler'
import { reconciledStateHash } from './simulation-reconciliation/broker-model'
import { decideContainment } from './simulation-reconciliation/broker-containment'
import {
  decideFillPage,
  decideOrderPage,
  decideStableHistory,
  readStableBrokerSnapshot,
} from './simulation-reconciliation/broker-history'
import { decideAccountBaseline } from './simulation-reconciliation/broker-normalization'
import { normalizeTimestamp } from './simulation-reconciliation/broker-reconciler-model'

const accountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const observedAt = '1970-01-01T00:00:00.000Z'
const hash = (value: unknown): string => Result.getOrThrow(canonicalHashV1Result(value))

const evidence = (identity: string, at = observedAt): ReadEvidence => ({
  requestId: `request-${identity}`,
  status: 200,
  contentHash: hash(identity),
  observedAt: at,
})

const account: BrokerAccount = {
  cryptoStatus: null,
  cryptoFeeTier: null,
  cashReportingQuantumMicros: '1' as const,
  nonMarginableBuyingPowerMicros: null,

  id: accountId,
  status: BrokerAccountStatus.Active,
  currency: 'USD',
  cashMicros: '1000000000',
  equityMicros: '1000000000',
  lastEquityMicros: '1000000000',
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
  submittedAt: utcInstantFromEpochMillis(index),
  assetId: `asset-${index}`,
  symbol: 'NVDA',
  assetClass: AssetClass.UsEquity,
  quantityAtoms: '1000000000',
  filledQuantityAtoms: '1000000000',
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
  cumulativeQuantityAtoms: '1000000000',
  leavesQuantityAtoms: '0',
  priceAtoms: '100000000000',
  quantityAtoms: '1000000000',
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
  const stateHash = Result.getOrThrow(
    reconciledStateHash({
      account: snapshot.account,
      positions: snapshot.positions,
      positionsObservedAt: snapshot.positionsObservedAt,
      orders: snapshot.orders,
      ordersObservedAt: snapshot.ordersObservedAt,
      accountingHash,
    }),
  )
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
      tradingDate: Result.getOrThrow(
        Schema.decodeUnknownResult(IsoDateSchema)(accountTradingDate(snapshot.valuation.asOf)),
      ),
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
  recordedHistory?: boolean
}

type TestStore = BrokerEventStoreShape &
  FillAccountingStoreShape &
  ValuationStoreShape &
  ReconciliationStoreShape &
  AuthorityRestrictionStoreShape

const makeStore = (control: StoreControl, hasAccountBaseline = true, at = observedAt): TestStore => ({
  completeHistory: (inputs) =>
    Effect.succeed(new Set(control.recordedHistory === true ? inputs.map((input) => input.sourceEventId) : [])),
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
  verifyCompleted: () => Effect.void,
  value: () =>
    Effect.sync(() => {
      control.writes += 1
      return { ...valuation, asOf: at }
    }),
  hasAccountBaseline: () => Effect.succeed(hasAccountBaseline),
  retainCashReporting: () => Effect.void,
  bindings: () => Effect.succeed([{ intentId: hash('intent'), clientOrderId: order(0).clientOrderId }]),
  reconcile: (_, snapshot) =>
    snapshot.pipe(
      Effect.map((snapshot) => {
        control.writes += 1
        control.reconciliations.push(snapshot)
        return { snapshot, persisted: report(snapshot) }
      }),
    ),
  restrictAuthority: (reason) =>
    Effect.sync(() => {
      control.restrictions.push(reason)
    }),
})

const emptyRead = (at = observedAt): BrokerReadShape => ({
  account: Effect.succeed({ value: { ...account, observedAt: at }, evidence: evidence('account', at) }),
  accountConfiguration: Effect.die(new Error('unexpected account configuration read')),
  assetBySymbol: unusedAssetBySymbol,
  positions: Effect.succeed({ value: [], evidence: evidence('positions', at) }),
  orders: () => Effect.succeed({ value: [], evidence: evidence('orders') }),
  feeActivities: () => Effect.succeed({ value: { items: [] }, evidence: evidence('fees') }),
  fillActivities: () => Effect.succeed({ value: { items: [] }, evidence: evidence('fills') }),
  orderById: () => Effect.die(new Error('unexpected order lookup')),
  orderByClientId: () => Effect.die(new Error('unexpected client order lookup')),
  marketCalendar: unusedMarketCalendar,
})

const descendingOrderPage = (orders: readonly BrokerOrder[], until: string | undefined, limit = 500) => {
  const cutoff =
    until === undefined ? undefined : Result.getOrThrow(normalizeTimestamp('order-timestamp', 'until', until))
  return orders
    .toReversed()
    .filter((row) => {
      if (row.submittedAt === undefined) throw new Error('Order fixture requires its original submission timestamp')
      return (
        cutoff === undefined ||
        Result.getOrThrow(normalizeTimestamp('order-timestamp', row.brokerOrderId, row.submittedAt)) < cutoff
      )
    })
    .slice(0, limit)
}

const fence: WriterFenceService = {
  check: Effect.void,
  transaction: (effect) => effect,
}

const provide = (
  read: BrokerReadShape,
  store: TestStore,
  writerFence = fence,
  clock: Effect.Effect<string, ReconciliationError> = Effect.succeed(observedAt),
) =>
  runOnce.pipe(
    Effect.provideService(BrokerRead, read),
    Effect.provideService(BrokerEventStore, store),
    Effect.provideService(FillAccountingStore, store),
    Effect.provideService(ValuationStore, store),
    Effect.provideService(ReconciliationStore, store),
    Effect.provideService(AuthorityRestrictionStore, store),
    Effect.provideService(WriterFence, writerFence),
    Effect.provideService(ReconciliationClock, clock),
  )

describe('reconciliation pure decisions', () => {
  test('classifies order and fill pages without effects', () => {
    const firstOrder = order(0)
    const orderPageEvidence = evidence('order-page')
    const orderPage = decideOrderPage(
      {
        rows: [],
        ids: HashSet.empty(),
        cursor: undefined,
        previousSubmittedAt: undefined,
        observedAt: undefined,
      },
      500,
      { value: [firstOrder], evidence: orderPageEvidence },
    )
    expect(orderPage).toEqual(
      Result.succeed({
        _tag: 'Complete',
        read: {
          rows: [{ value: firstOrder, evidence: orderPageEvidence }],
          observedAt: orderPageEvidence.observedAt,
        },
      }),
    )

    const missingTimestamp = decideOrderPage(
      {
        rows: [],
        ids: HashSet.empty(),
        cursor: undefined,
        previousSubmittedAt: undefined,
        observedAt: undefined,
      },
      500,
      {
        value: [(({ submittedAt: _submittedAt, ...orderWithoutSubmittedAt }) => orderWithoutSubmittedAt)(firstOrder)],
        evidence: orderPageEvidence,
      },
    )
    expect(missingTimestamp).toMatchObject({
      _tag: 'Failure',
      failure: {
        failure: { _tag: 'Pagination', reason: 'OrderSubmittedAtMissing' },
      },
    })

    const firstFill = fill(0, firstOrder)
    const fillPageEvidence = evidence('fill-page')
    const fillPage = decideFillPage({ rows: [], ids: HashSet.empty(), cursor: undefined }, 1, {
      value: { items: [firstFill], nextPageToken: firstFill.activityId },
      evidence: fillPageEvidence,
    })
    expect(fillPage).toEqual(
      Result.succeed({
        _tag: 'Continue',
        state: {
          rows: [{ value: firstFill, evidence: fillPageEvidence }],
          ids: HashSet.make(firstFill.activityId),
          cursor: firstFill.activityId,
        },
      }),
    )
  })

  test('rejects duplicate, reversed and nonadvancing order pages', () => {
    const state = {
      rows: [],
      ids: HashSet.empty<string>(),
      cursor: undefined,
      previousSubmittedAt: undefined,
      observedAt: undefined,
    }
    const first = order(1)
    const last = order(0)
    const pageEvidence = evidence('descending-order-page')
    expect(decideOrderPage(state, 2, { value: [first, first], evidence: pageEvidence })).toMatchObject({
      _tag: 'Failure',
      failure: { failure: { _tag: 'Pagination', reason: 'DuplicateOrder' } },
    })
    expect(decideOrderPage(state, 2, { value: [last, first], evidence: pageEvidence })).toMatchObject({
      _tag: 'Failure',
      failure: { failure: { _tag: 'Pagination', reason: 'OrderHistoryNotDescending' } },
    })
    const next = Result.getOrThrow(decideOrderPage(state, 2, { value: [first, last], evidence: pageEvidence }))
    if (next._tag !== 'Continue') throw new Error('Full order page must retain its exclusive cursor')
    expect(next.state.rows.map(({ value }) => value.brokerOrderId)).toEqual([first.brokerOrderId])
    expect(HashSet.has(next.state.ids, last.brokerOrderId)).toBe(false)
    expect(decideOrderPage(next.state, 2, { value: [first], evidence: pageEvidence })).toMatchObject({
      _tag: 'Failure',
      failure: { failure: { _tag: 'Pagination', reason: 'OrderTimestampCursorDidNotAdvance' } },
    })
    expect(decideOrderPage(next.state, 2, { value: [last], evidence: pageEvidence })).toMatchObject({
      _tag: 'Success',
      success: { _tag: 'Complete', read: { rows: [{ value: first }, { value: last }] } },
    })
    expect(decideOrderPage(state, 3, { value: [first, last, last], evidence: pageEvidence })).toMatchObject({
      _tag: 'Failure',
      failure: { failure: { _tag: 'Pagination', reason: 'DuplicateOrder' } },
    })
  })

  test('defers the entire oldest order group using normalized nanosecond precision', () => {
    const newest = { ...order(2), submittedAt: '2026-10-19T12:00:00.000000030Z' }
    const firstSibling = { ...order(1), submittedAt: '2026-10-19T12:00:00.000000020Z' }
    const secondSibling = { ...order(0), submittedAt: '2026-10-19T12:00:00.00000002Z' }
    const pageEvidence = evidence('nanosecond-order-page')
    const next = Result.getOrThrow(
      decideOrderPage(
        {
          rows: [],
          ids: HashSet.empty(),
          cursor: undefined,
          previousSubmittedAt: undefined,
          observedAt: undefined,
        },
        3,
        { value: [newest, firstSibling, secondSibling], evidence: pageEvidence },
      ),
    )
    if (next._tag !== 'Continue') throw new Error('The whole boundary group must be reread')
    expect(next.state.cursor).toBe(newest.submittedAt)
    expect(next.state.previousSubmittedAt).toBe(newest.submittedAt)
    expect(next.state.rows).toEqual([{ value: newest, evidence: pageEvidence }])
    expect(HashSet.has(next.state.ids, firstSibling.brokerOrderId)).toBe(false)
    expect(HashSet.has(next.state.ids, secondSibling.brokerOrderId)).toBe(false)
    expect(decideOrderPage(next.state, 3, { value: [firstSibling, secondSibling], evidence: pageEvidence })).toEqual(
      Result.succeed({
        _tag: 'Complete',
        read: {
          rows: [newest, firstSibling, secondSibling].map((value) => ({ value, evidence: pageEvidence })),
          observedAt,
        },
      }),
    )
  })

  test('nested bracket children consume the page limit without ending older order history', () => {
    const state = {
      rows: [],
      ids: HashSet.empty<string>(),
      cursor: undefined,
      previousSubmittedAt: undefined,
      observedAt: undefined,
    }
    const newest: BrokerOrder = {
      ...order(3),
      orderClass: OrderClass.Bracket,
      legs: [order(4), order(5)],
    }
    const middle = order(2)
    const deferred = order(1)
    const older = order(0)
    const pageEvidence = evidence('nested-order-page')
    const page = { value: [newest, middle, deferred], evidence: pageEvidence }
    const next = Result.getOrThrow(decideOrderPage(state, 5, page))
    expect(next._tag).toBe('Continue')
    if (next._tag !== 'Continue') return
    expect(next.state.rows.map(({ value }) => value.brokerOrderId)).toEqual([
      newest.brokerOrderId,
      middle.brokerOrderId,
    ])
    expect(next.state.cursor).toBe(middle.submittedAt)
    expect(HashSet.has(next.state.ids, deferred.brokerOrderId)).toBe(false)
    expect(decideOrderPage(next.state, 5, { value: [deferred, older], evidence: pageEvidence })).toMatchObject({
      _tag: 'Success',
      success: {
        _tag: 'Complete',
        read: {
          rows: [newest, middle, deferred, older].map((value) => ({ value, evidence: pageEvidence })),
        },
      },
    })
    expect(decideOrderPage(state, 6, page)).toMatchObject({
      _tag: 'Success',
      success: { _tag: 'Complete' },
    })
  })

  test('validates the entire order page against the row budget before deferring its boundary', () => {
    const pageEvidence = evidence('order-row-budget')
    const existing = Array.from({ length: 9_999 }, (_, index) => ({
      ...order(index),
      submittedAt: utcInstantFromEpochMillis(index + 2),
    })).toReversed()
    const state = {
      rows: existing.map((value) => ({ value, evidence: pageEvidence })),
      ids: HashSet.fromIterable(existing.map((value) => value.brokerOrderId)),
      cursor: utcInstantFromEpochMillis(2),
      previousSubmittedAt: utcInstantFromEpochMillis(2),
      observedAt,
    }
    const lastAllowed = { ...order(9_999), submittedAt: utcInstantFromEpochMillis(1) }
    const excess = { ...order(10_000), submittedAt: utcInstantFromEpochMillis(0) }
    const complete = Result.getOrThrow(decideOrderPage(state, 2, { value: [lastAllowed], evidence: pageEvidence }))
    if (complete._tag !== 'Complete') throw new Error('A short in-budget page completes the history')
    expect(complete.read.rows).toHaveLength(10_000)
    expect(decideOrderPage(state, 2, { value: [lastAllowed, excess], evidence: pageEvidence })).toMatchObject({
      _tag: 'Failure',
      failure: { failure: { _tag: 'Pagination', reason: 'OrderHistoryTooLarge' } },
    })
  })

  test('bracket history stays stable across reads while retaining child execution changes', () => {
    const { filledAveragePriceMicros: _price, ...unfilled } = order(0)
    const child: BrokerOrder = {
      ...unfilled,
      brokerOrderId: 'protective-stop',
      clientOrderId: 'protective-stop-client',
      parentBrokerOrderId: unfilled.brokerOrderId,
      orderClass: OrderClass.Bracket,
      orderType: BrokerOrderType.StopLimit,
      side: BrokerSide.Sell,
      status: BrokerOrderStatus.New,
      filledQuantityAtoms: '0',
      limitPriceMicros: '274520000',
      stopPriceMicros: '274790000',
    }
    const { stopPriceMicros: _stop, ...limitChild } = child
    const profit: BrokerOrder = {
      ...limitChild,
      brokerOrderId: 'profit-target',
      clientOrderId: 'profit-target-client',
      orderType: BrokerOrderType.Limit,
      limitPriceMicros: '276740000',
    }
    const parent: BrokerOrder = {
      ...unfilled,
      orderClass: OrderClass.Bracket,
      orderType: BrokerOrderType.Limit,
      status: BrokerOrderStatus.New,
      filledQuantityAtoms: '0',
      limitPriceMicros: '275400000',
      legs: [child, profit],
    }
    const before = {
      orders: { rows: [{ value: parent, evidence: evidence('before-bracket') }], observedAt },
      fills: [],
      fees: [],
    }
    const readAt = utcInstantFromEpochMillis(1_000)
    const laterParent: BrokerOrder = {
      ...parent,
      observedAt: readAt,
      legs: [child, profit].map((leg) => ({ ...leg, observedAt: readAt })),
    }
    const after = {
      ...before,
      orders: { rows: [{ value: laterParent, evidence: evidence('after-bracket') }], observedAt: readAt },
    }
    expect(decideStableHistory(before, after)).toEqual(Result.succeed(after))
    for (const changedChild of [
      { ...child, observedAt: readAt, status: BrokerOrderStatus.Canceled },
      { ...child, observedAt: readAt, stopPriceMicros: '274800000' },
      { ...child, observedAt: readAt, filledQuantityAtoms: '1' },
      { ...child, observedAt: readAt, submittedAt: readAt },
    ]) {
      expect(
        decideStableHistory(before, {
          ...after,
          orders: {
            ...after.orders,
            rows: [
              {
                value: { ...laterParent, legs: [changedChild, { ...profit, observedAt: readAt }] },
                evidence: evidence('changed-bracket'),
              },
            ],
          },
        }),
      ).toMatchObject({
        _tag: 'Failure',
        failure: { failure: { _tag: 'Snapshot', reason: 'HistoryChanged' } },
      })
    }
  })

  test.each(
    [OrderClass.Bracket, OrderClass.OneCancelsOther].flatMap((orderClass) =>
      [false, true].map((permanent) => ({ orderClass, permanent })),
    ),
  )(
    'waits for nested $orderClass child fill activity convergence; permanent=$permanent',
    async ({ orderClass, permanent }) => {
      const bracket = orderClass === OrderClass.Bracket
      const parent = {
        ...order(0),
        orderClass,
        orderType: BrokerOrderType.Limit,
        side: bracket ? BrokerSide.Buy : BrokerSide.Sell,
        filledQuantityAtoms: bracket ? '1000000000' : '0',
        status: bracket ? BrokerOrderStatus.Filled : BrokerOrderStatus.Canceled,
        limitPriceMicros: '110000000',
      }
      const child = {
        ...order(1),
        parentBrokerOrderId: parent.brokerOrderId,
        side: BrokerSide.Sell,
        orderType: BrokerOrderType.StopLimit,
        stopPriceMicros: '90000000',
        limitPriceMicros: '89000000',
      }
      const profit = {
        ...order(2),
        parentBrokerOrderId: parent.brokerOrderId,
        side: BrokerSide.Sell,
        orderType: BrokerOrderType.Limit,
        limitPriceMicros: '110000000',
        filledQuantityAtoms: '0',
        status: BrokerOrderStatus.Canceled,
      }
      const nested = { ...parent, legs: bracket ? [child, profit] : [child] }
      expect(
        Result.isSuccess(
          verifyProtectionGroup(nested, {
            symbol: parent.symbol,
            quantityAtoms: '1000000000',
            protection: {
              _tag: bracket ? 'Bracket' : 'Oco',
              entryDecisionHash: hash('entry-decision'),
              stopPriceMicros: '90000000',
              stopLimitPriceMicros: '89000000',
              profitLimitPriceMicros: '110000000',
            },
          }),
        ),
      ).toBe(true)
      const parentFill = fill(0, parent)
      const childFill = fill(1, child)
      const parentFills = bracket ? [parentFill] : []
      const history = {
        orders: { rows: [{ value: nested, evidence: evidence('nested-order') }], observedAt },
        fills: parentFills.map((value) => ({ value, evidence: evidence('parent-fill') })),
        fees: [],
      }
      expect(decideStableHistory(history, history)).toMatchObject({
        _tag: 'Failure',
        failure: { failure: { _tag: 'Snapshot', reason: 'FillActivitiesPending' } },
      })
      let fillReads = 0
      const read: BrokerReadShape = {
        ...emptyRead(),
        orders: () => Effect.succeed({ value: [nested], evidence: evidence('nested-orders') }),
        fillActivities: () =>
          Effect.sync(() => ({
            value: { items: ++fillReads <= 2 || permanent ? parentFills : [...parentFills, childFill] },
            evidence: evidence('nested-fills'),
          })),
      }
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* readStableBrokerSnapshot(read, Effect.succeed(observedAt)).pipe(
              Effect.result,
              Effect.forkScoped({ startImmediately: true }),
            )
            yield* TestClock.adjust(1000)
            return yield* Fiber.join(fiber)
          }),
        ).pipe((self) => provideTestLayer(self, TestClock.layer())),
      )
      if (permanent) {
        expect(fillReads).toBe(6)
        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { failure: { _tag: 'Snapshot', reason: 'FillActivitiesPending' } },
        })
      } else {
        expect(fillReads).toBe(4)
        expect(Result.getOrThrow(result).history.fills.map(({ value }) => value)).toEqual([...parentFills, childFill])
      }
    },
  )

  test('classifies stable history, missing baselines, and containment without effects', () => {
    const emptyHistory = {
      orders: { rows: [], observedAt },
      fills: [],
      fees: [],
    }
    expect(decideStableHistory(emptyHistory, emptyHistory)).toEqual(Result.succeed(emptyHistory))

    const changedHistory = {
      ...emptyHistory,
      fills: [{ value: fill(0), evidence: evidence('changed-fill') }],
    }
    expect(decideStableHistory(emptyHistory, changedHistory)).toMatchObject({
      _tag: 'Failure',
      failure: {
        failure: { _tag: 'Snapshot', reason: 'HistoryChanged' },
      },
    })

    expect(decideAccountBaseline(true)).toEqual(Result.succeed(undefined))
    expect(decideAccountBaseline(false)).toMatchObject({
      _tag: 'Failure',
      failure: {
        failure: { _tag: 'Snapshot', reason: 'AccountBaselineMissing' },
      },
    })
    const retryableRead = new BrokerReadError({
      operation: 'account',
      kind: BrokerReadErrorKind.Transport,
      message: 'transient read failure',
      retryable: true,
    })
    expect(decideContainment(Cause.fail(retryableRead))).toEqual({ _tag: 'PreserveAuthority' })

    const invalidRead = new BrokerReadError({
      operation: 'account',
      kind: BrokerReadErrorKind.InvalidResponse,
      message: 'invalid account response',
      retryable: false,
    })
    expect(decideContainment(Cause.fail(invalidRead))).toEqual({
      _tag: 'RestrictAuthority',
      reason: 'reconciliation pass incomplete',
    })
  })
})

describe('execution reconciliation loop', () => {
  test.each([false, true])('retains a clock failure when containment clock also fails: %s', async (persistent) => {
    const clockFailure = new ReconciliationError({
      operation: 'clock',
      failure: { _tag: 'Clock' },
      message: 'Measured replay clock unavailable',
    })
    let reads = 0
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    const failed = await Effect.runPromise(
      provide(
        emptyRead(),
        makeStore(control),
        fence,
        Effect.suspend(() => {
          reads += 1
          return persistent || reads === 1 ? Effect.fail(clockFailure) : Effect.succeed(observedAt)
        }),
      ).pipe(Effect.flip),
    )
    expect(control.writes).toBe(0)
    expect(control.reconciliations).toEqual([])
    expect(reads).toBe(2)
    if (persistent) {
      if (!(failed instanceof ReconciliationError) || failed.failure?._tag !== 'AuthorityRestrictionFailed')
        throw new Error('Expected both reconciliation and containment failures')
      expect(Cause.squash(failed.failure.reconciliationCause)).toBe(clockFailure)
      expect(Cause.squash(failed.failure.restrictionCause)).toBe(clockFailure)
      expect(control.restrictions).toEqual([])
    } else {
      expect(failed).toBe(clockFailure)
      expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
    }
  })

  test('recovers a retryable broker read on the next pass without restricting authority', async () => {
    const transientFailure = new BrokerReadError({
      operation: 'account',
      kind: BrokerReadErrorKind.Transport,
      message: 'injected transient account read failure',
      retryable: true,
    })
    let accountReads = 0
    const read: BrokerReadShape = {
      ...emptyRead(),
      account: Effect.suspend(() => {
        accountReads += 1
        return accountReads === 1
          ? Effect.fail(transientFailure)
          : Effect.succeed({ value: account, evidence: evidence(`account-${accountReads.toString()}`) })
      }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    const program = provide(read, makeStore(control))

    const failure = await Effect.runPromise(program.pipe(Effect.flip))
    expect(failure).toBe(transientFailure)
    expect(control.restrictions).toEqual([])

    const recovered = await Effect.runPromise(program)
    expect(recovered.report.reconciliation.status).toBe(ReconciliationStatus.Exact)
    expect(control.reconciliations).toHaveLength(1)
    expect(control.restrictions).toEqual([])
  })

  test('captures a complete 500-order history when the newest order has different cache and database precision', async () => {
    const cut = '2026-10-18T21:33:41.010Z'
    const newest = {
      ...order(499),
      submittedAt: '2026-10-18T21:27:20.865651915Z',
      status: BrokerOrderStatus.Canceled,
      filledQuantityAtoms: '0',
    }
    const allOrders = Array.from({ length: 499 }, (_, index) => ({
      ...order(index),
      status: BrokerOrderStatus.Canceled,
      filledQuantityAtoms: '0',
    })).concat(newest)
    const requests: Array<{ readonly after?: string; readonly until?: string; readonly direction?: string }> = []
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: (query = {}) => {
        requests.push(query)
        const pageObservedAt = utcInstantFromEpochMillis(Date.parse(cut) + requests.length * 100)
        const value = descendingOrderPage(allOrders, query.until, query.limit)
        return Effect.succeed({
          value: value.map((row) => ({ ...row, observedAt: pageObservedAt })),
          evidence: { ...evidence(`precision-page-${requests.length}`), observedAt: pageObservedAt },
        })
      },
    }

    const snapshot = await Effect.runPromise(readStableBrokerSnapshot(read, Effect.succeed(cut)))

    expect(snapshot.history.orders.rows.map(({ value }) => value.brokerOrderId).toSorted()).toEqual(
      allOrders.map((value) => value.brokerOrderId).toSorted(),
    )
    expect(snapshot.history.orders.observedAt).toBe(utcInstantFromEpochMillis(Date.parse(cut) + 400))
    expect(snapshot.history.orders.observedAt).toBe(
      snapshot.history.orders.rows.reduce(
        (latest, row) => (row.value.observedAt > latest ? row.value.observedAt : latest),
        '',
      ),
    )
    expect(requests).toHaveLength(4)
    expect(requests.every((query) => query.direction === SortDirection.Descending && query.after === undefined)).toBe(
      true,
    )
    expect(requests.map((query) => query.until)).toEqual([
      cut,
      allOrders[1]?.submittedAt,
      cut,
      allOrders[1]?.submittedAt,
    ])
  })

  test.each([2, 3])(
    'captures hidden order siblings when a %s-order timestamp group crosses a full page',
    async (groupSize) => {
      const cut = utcInstantFromEpochMillis(1_000)
      const allOrders = Array.from({ length: 501 }, (_, index) => ({
        ...order(index),
        submittedAt: utcInstantFromEpochMillis(index < groupSize ? 1 : index),
        status: BrokerOrderStatus.Canceled,
        filledQuantityAtoms: '0',
      }))
      const orderCursors: Array<string | undefined> = []
      const read: BrokerReadShape = {
        ...emptyRead(),
        orders: (query = {}) => {
          orderCursors.push(query.until)
          return Effect.succeed({
            value: descendingOrderPage(allOrders, query.until, query.limit),
            evidence: evidence(`hidden-sibling-page-${orderCursors.length}`),
          })
        },
      }
      const snapshot = await Effect.runPromise(readStableBrokerSnapshot(read, Effect.succeed(cut)))
      expect(snapshot.history.orders.rows.map(({ value }) => value.brokerOrderId).toSorted()).toEqual(
        allOrders.map((value) => value.brokerOrderId).toSorted(),
      )
      expect(orderCursors).toEqual([cut, allOrders[groupSize]?.submittedAt, cut, allOrders[groupSize]?.submittedAt])
    },
  )

  test.each([500, 501])('fails closed when a %s-order timestamp group fills the provider page', async (count) => {
    const cut = utcInstantFromEpochMillis(1_000)
    const allOrders = Array.from({ length: count }, (_, index) => ({
      ...order(index),
      submittedAt: utcInstantFromEpochMillis(1),
      status: BrokerOrderStatus.Canceled,
      filledQuantityAtoms: '0',
    }))
    let reads = 0
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: (query = {}) => {
        reads += 1
        return Effect.succeed({
          value: descendingOrderPage(allOrders, query.until, query.limit),
          evidence: evidence(`ambiguous-order-page-${reads}`),
        })
      },
    }
    const failure = await Effect.runPromise(readStableBrokerSnapshot(read, Effect.succeed(cut)).pipe(Effect.flip))
    expect(failure).toMatchObject({
      operation: 'pagination',
      failure: { _tag: 'Pagination', reason: 'OrderCursorDidNotAdvance' },
    })
    expect(reads).toBe(1)
  })

  test('reads every broker page before persisting and binds fills to their orders', async () => {
    const cut = utcInstantFromEpochMillis(1_000)
    const allOrders = Array.from({ length: 501 }, (_, index) =>
      index < 101 ? order(index) : { ...order(index), status: BrokerOrderStatus.New, filledQuantityAtoms: '0' },
    )
    const allFills = Array.from({ length: 101 }, (_, index) => fill(index, allOrders[index]))
    const orderCursors: Array<string | undefined> = []
    const fillCursors: Array<string | undefined> = []
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: (query = {}) => {
        orderCursors.push(query.until)
        return Effect.succeed({
          value: descendingOrderPage(allOrders, query.until, query.limit),
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

    const result = await Effect.runPromise(provide(read, makeStore(control), fence, Effect.succeed(cut)))

    expect(orderCursors).toEqual([cut, allOrders[2].submittedAt, cut, allOrders[2].submittedAt])
    expect(fillCursors).toEqual([undefined, allFills[99].activityId, undefined, allFills[99].activityId])
    expect(control.reconciliations).toHaveLength(1)
    expect(control.reconciliations[0].orders).toHaveLength(501)
    expect(control.reconciliations[0].fills).toHaveLength(101)
    expect(control.reconciliations[0].orders.filter((value) => value.intentId === hash('intent'))).toHaveLength(1)
    expect(control.reconciliations[0].fills[0].intentId).toBe(hash('intent'))
    expect(result.brokerState.orders.map((candidate) => candidate.brokerOrderId)).toEqual(
      allOrders.map((candidate) => candidate.brokerOrderId).sort(),
    )
    expect(result.brokerState.unknownOrderCount).toBe(500)
    const stateHash = Result.getOrThrow(reconciledStateHash(result.brokerState))
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

  test('preserves causal broker read order and clock cutoffs', async () => {
    let accountReads = 0
    let positionReads = 0
    let orderReads = 0
    let fillReads = 0
    const orderCutoffs: Array<string | undefined> = []
    const fillCutoffs: Array<string | undefined> = []
    const read: BrokerReadShape = {
      ...emptyRead(),
      account: Effect.gen(function* () {
        expect(orderReads).toBe(1)
        expect(fillReads).toBe(1)
        accountReads += 1
        yield* TestClock.adjust(100)
        return { value: account, evidence: evidence('account') }
      }),
      positions: Effect.sync(() => {
        expect(orderReads).toBe(1)
        expect(fillReads).toBe(1)
        positionReads += 1
        return { value: [], evidence: evidence('positions') }
      }),
      orders: (query = {}) =>
        Effect.sync(() => {
          orderReads += 1
          orderCutoffs.push(query.until)
          if (orderReads === 1) {
            expect(accountReads).toBe(0)
            expect(positionReads).toBe(0)
          } else {
            expect(accountReads).toBe(1)
            expect(positionReads).toBe(1)
          }
          return { value: [], evidence: evidence(`orders-${orderReads}`) }
        }),
      fillActivities: (query = {}) =>
        Effect.sync(() => {
          fillReads += 1
          fillCutoffs.push(query.until)
          if (fillReads === 1) {
            expect(accountReads).toBe(0)
            expect(positionReads).toBe(0)
          } else {
            expect(accountReads).toBe(1)
            expect(positionReads).toBe(1)
          }
          return { value: { items: [] }, evidence: evidence(`fills-${fillReads}`) }
        }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const result = await Effect.runPromise(
      provide(read, makeStore(control), fence, currentUtcInstant).pipe((self) =>
        provideTestLayer(self, TestClock.layer()),
      ),
    )

    expect(orderCutoffs).toEqual(['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.100Z'])
    expect(fillCutoffs).toEqual(orderCutoffs)
    expect(control.reconciliations).toHaveLength(1)
    expect(control.reconciliations[0].reconciledAt).toBe('1970-01-01T00:00:00.100Z')
    expect(result.report.reconciliation.reconciledAt).toBe('1970-01-01T00:00:00.100Z')
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

    expect(failure).toBeInstanceOf(ReconciliationError)
    expect(failure).toMatchObject({
      _tag: 'ReconciliationError',
      operation: 'snapshot',
      message: 'broker account has fill history before Bayn established an opening cash baseline',
      failure: {
        _tag: 'Snapshot',
        reason: 'AccountBaselineMissing',
      },
    })
    expect(control.writes).toBe(0)
    expect(control.reconciliations).toEqual([])
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('fails closed before persistence when an order omits submitted_at', async () => {
    const pendingOrder = (({ submittedAt: _submittedAt, ...orderWithoutSubmittedAt }) => orderWithoutSubmittedAt)(
      order(0),
    )
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: () => Effect.succeed({ value: [pendingOrder], evidence: evidence('orders') }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const failure = await Effect.runPromise(provide(read, makeStore(control)).pipe(Effect.flip))

    expect(failure).toMatchObject({
      _tag: 'ReconciliationError',
      operation: 'pagination',
      message: `Alpaca order ${pendingOrder.brokerOrderId} is missing submitted_at`,
      failure: {
        _tag: 'Pagination',
        reason: 'OrderSubmittedAtMissing',
      },
    })
    expect(control.writes).toBe(0)
    expect(control.reconciliations).toEqual([])
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('retains the exact typed cause of a normalization failure', async () => {
    const malformedOrder = { ...order(0), extendedHours: true, filledQuantityAtoms: '0' }
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: () => Effect.succeed({ value: [malformedOrder], evidence: evidence('orders') }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const failure = await Effect.runPromise(provide(read, makeStore(control)).pipe(Effect.flip))

    expect(failure).toBeInstanceOf(ReconciliationError)
    if (!(failure instanceof ReconciliationError) || failure.failure?._tag !== 'Normalization') {
      throw new Error('expected a reconciliation normalization failure')
    }
    expect(failure).toMatchObject({
      _tag: 'ReconciliationError',
      operation: 'normalization',
      message: `extended hours require a stock LIMIT with DAY or GTC for ${malformedOrder.brokerOrderId}`,
      failure: {
        _tag: 'Normalization',
        stage: 'order',
        identity: malformedOrder.brokerOrderId,
        error: {
          _tag: 'ExtendedHoursUnsupported',
          brokerOrderId: malformedOrder.brokerOrderId,
        },
      },
    })
    expect(failure.cause).toEqual({
      _tag: 'ExtendedHoursUnsupported',
      brokerOrderId: malformedOrder.brokerOrderId,
    })
    expect(control.writes).toBe(0)
    expect(control.reconciliations).toEqual([])
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('returns a closed duplicate-client validation reason', async () => {
    const first = order(0)
    const duplicateClient = { ...order(1), clientOrderId: first.clientOrderId }
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: () => Effect.succeed({ value: [duplicateClient, first], evidence: evidence('orders') }),
      fillActivities: () =>
        Effect.succeed({ value: { items: [fill(0, first), fill(1, duplicateClient)] }, evidence: evidence('fills') }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const failure = await Effect.runPromise(provide(read, makeStore(control)).pipe(Effect.flip))

    expect(failure).toBeInstanceOf(ReconciliationError)
    if (!(failure instanceof ReconciliationError) || failure.failure?._tag !== 'Validation') {
      throw new Error('expected a reconciliation validation failure')
    }
    expect(failure).toMatchObject({
      _tag: 'ReconciliationError',
      operation: 'normalization',
      message: `duplicate broker client order ID ${first.clientOrderId}`,
      failure: {
        _tag: 'Validation',
        reason: 'DuplicateBrokerClientOrderId',
        detail: `duplicate broker client order ID ${first.clientOrderId}`,
      },
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
      orders: () => Effect.succeed({ value: [laterOrder, earlierOrder], evidence: evidence('orders') }),
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

  test('reconciles a repeated snapshot without reingesting completed orders and fills', async () => {
    const brokerOrder = order(0)
    const brokerFill = fill(0, brokerOrder)
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: () => Effect.succeed({ value: [brokerOrder], evidence: evidence('orders') }),
      fillActivities: () => Effect.succeed({ value: { items: [brokerFill] }, evidence: evidence('fills') }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    const store = makeStore(control)

    await Effect.runPromise(provide(read, store))
    const firstPassWrites = control.writes
    control.recordedHistory = true
    await Effect.runPromise(provide(read, store))

    expect(firstPassWrites).toBe(6)
    expect(control.writes - firstPassWrites).toBe(4)
    expect(control.reconciliations).toHaveLength(2)
    expect(control.reconciliations[1].fills).toEqual(control.reconciliations[0].fills)
  })

  test('does not reconcile or reuse a completed fill when its accounting verification fails', async () => {
    const brokerOrder = order(0)
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: () => Effect.succeed({ value: [brokerOrder], evidence: evidence('orders') }),
      fillActivities: () => Effect.succeed({ value: { items: [fill(0, brokerOrder)] }, evidence: evidence('fills') }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [], recordedHistory: true }
    const failure = new ExecutionStoreError({
      operation: 'account',
      failure: 'conflict',
      message: 'stored accounting plan differs from deterministic replay',
    })
    const store: TestStore = {
      ...makeStore(control),
      verifyCompleted: (inputs) => (inputs.length > 0 ? Effect.fail(failure) : Effect.void),
    }

    const exit = await Effect.runPromiseExit(provide(read, store))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failures = exit.cause.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [reason.error] : []))
      expect(failures).toEqual([failure])
    }
    expect(control.reconciliations).toEqual([])
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
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
    expect(failure).toMatchObject({
      failure: {
        _tag: 'Pagination',
        reason: 'DuplicateFill',
      },
    })
    expect(control.writes).toBe(0)
    expect(control.reconciliations).toEqual([])
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('retains current UTC-day crypto fees through daily pagination and stable capture', async () => {
    const cut = '2026-10-15T09:56:00.000Z'
    const fees = [
      {
        accountId,
        activityId: 'same-day-coin',
        date: '2026-10-15',
        netAmountMicros: '0',
        coinDebit: { symbol: 'ETH/USD', quantityAtoms: '82708', priceAtoms: '2364150000000' },
      },
      {
        accountId,
        activityId: 'same-day-cash',
        date: '2026-10-15',
        netAmountMicros: '-200000',
        cryptoCashFee: true as const,
      },
    ] as const
    let reads = 0
    const read: BrokerReadShape = {
      ...emptyRead(cut),
      feeActivities: (query) => {
        reads += 1
        // Observed PAPER behavior: timestamp-bounded non-trade reads omit current-day CFEE receipts.
        const items = Object.hasOwn(query ?? {}, 'until') ? [] : [fees[query?.pageToken === undefined ? 0 : 1]]
        return Effect.succeed({
          value: {
            items,
            ...(items.length > 0 && query?.pageToken === undefined ? { nextPageToken: 'same-day-coin' } : {}),
          },
          evidence: { ...evidence('current-day-fees'), observedAt: cut },
        })
      },
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    await Effect.runPromise(provide(read, makeStore(control, true, cut), fence, Effect.succeed(cut)))
    expect(control.reconciliations[0]?.fees.map((row) => row.value)).toEqual([...fees])
    expect(reads).toBe(4)
    expect(control.restrictions).toEqual([])
  })

  test('recaptures late fee postings before persisting an account snapshot', async () => {
    let reads = 0
    const cut = '2026-07-22T12:00:00.000Z'
    const fee = { accountId: account.id, activityId: 'fee-1', date: '2026-07-22', netAmountMicros: '-230000' }
    const read: BrokerReadShape = {
      ...emptyRead(cut),
      feeActivities: () => {
        reads += 1
        return Effect.succeed({
          value: { items: reads === 1 ? [] : [fee] },
          evidence: { ...evidence(`fees-${reads}`), observedAt: '2026-07-22T12:00:00.000Z' },
        })
      },
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(cut))
          const fiber = yield* provide(read, makeStore(control, true, cut), fence, currentUtcInstant).pipe(
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* TestClock.adjust(500)
          yield* Fiber.join(fiber)
        }),
      ).pipe((self) => provideTestLayer(self, TestClock.layer())),
    )
    expect(reads).toBe(4)
    expect(control.reconciliations[0]?.fees.map((item) => item.value)).toEqual([fee])
    expect(control.restrictions).toEqual([])
  })

  test.each([1, 101])(
    'retains %d available fee settlements excluded by the provider creation-time filter',
    async (count) => {
      const cut = '2026-10-15T08:00:00.000Z'
      const fees = Array.from({ length: count }, (_, index) => ({
        accountId,
        activityId: `available-fee-${String(index).padStart(3, '0')}`,
        date: '2026-10-15',
        netAmountMicros: '-230000',
      }))
      const feeEvidence = { ...evidence('available-fee'), observedAt: cut }
      const read: BrokerReadShape = {
        ...emptyRead(),
        feeActivities: (query) => {
          const start = query?.pageToken === undefined ? 0 : 100
          const items = Object.hasOwn(query ?? {}, 'until') ? [] : fees.slice(start, start + 100)
          const last = items.at(-1)
          return Effect.succeed({
            value: {
              items,
              ...(items.length === 100 && last !== undefined ? { nextPageToken: last.activityId } : {}),
            },
            evidence: feeEvidence,
          })
        },
      }

      const snapshot = await Effect.runPromise(readStableBrokerSnapshot(read, Effect.succeed(cut)))
      expect(snapshot.history.fees).toEqual(fees.map((value) => ({ value, evidence: feeEvidence })))
    },
  )

  test('rejects duplicate fee history before accounting', async () => {
    const fee = { accountId: account.id, activityId: 'fee-1', date: '2026-07-22', netAmountMicros: '-230000' }
    const read: BrokerReadShape = {
      ...emptyRead(),
      feeActivities: () => Effect.succeed({ value: { items: [fee, fee] }, evidence: evidence('fees') }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    const failure = await Effect.runPromise(provide(read, makeStore(control)).pipe(Effect.flip))
    expect(failure).toMatchObject({ failure: { _tag: 'Pagination', reason: 'InvalidFeeHistory' } })
    expect(control.writes).toBe(0)
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('rejects a future UTC-day fee before accounting', async () => {
    const read: BrokerReadShape = {
      ...emptyRead(),
      feeActivities: () =>
        Effect.succeed({
          value: { items: [{ accountId, activityId: 'future-fee', date: '2026-10-16', netAmountMicros: '-200000' }] },
          evidence: { ...evidence('future-fee'), observedAt: '2026-10-15T23:59:59.999Z' },
        }),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    const failure = await Effect.runPromise(
      provide(read, makeStore(control), fence, Effect.succeed('2026-10-15T23:59:59.999Z')).pipe(Effect.flip),
    )
    expect(failure).toMatchObject({ failure: { _tag: 'Pagination', reason: 'InvalidFeeHistory' } })
    expect(control.writes).toBe(0)
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('recaptures a broker mutation that races the account snapshot before persisting', async () => {
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

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* provide(read, makeStore(control)).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* TestClock.adjust(500)
          yield* Fiber.join(fiber)
        }),
      ).pipe((self) => provideTestLayer(self, TestClock.layer())),
    )

    expect(orderReads).toBe(4)
    expect(fillReads).toBe(4)
    expect(control.reconciliations).toHaveLength(1)
    expect(control.restrictions).toEqual([])
  })
  test.each([false, true])('waits for broker fill activity convergence; permanent=%s', async (permanent) => {
    let fillReads = 0
    const sourceOrder = order(0)
    const sourceFill = fill(0, sourceOrder)
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    const read: BrokerReadShape = {
      ...emptyRead(),
      orders: () => Effect.succeed({ value: [sourceOrder], evidence: evidence('order') }),
      fillActivities: () =>
        Effect.sync(() => {
          fillReads += 1
          expect(control.writes).toBe(0)
          return { value: { items: permanent || fillReads <= 2 ? [] : [sourceFill] }, evidence: evidence('fills') }
        }),
    }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* provide(read, makeStore(control)).pipe(
            Effect.result,
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* TestClock.adjust(1000)
          return yield* Fiber.join(fiber)
        }),
      ).pipe((self) => provideTestLayer(self, TestClock.layer())),
    )
    if (permanent) {
      expect(Result.isFailure(result)).toBe(true)
      expect(fillReads).toBe(6)
      expect(control.writes).toBe(0)
      expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
    } else {
      expect(Result.isSuccess(result)).toBe(true)
      expect(fillReads).toBe(4)
      expect(control.reconciliations).toHaveLength(1)
      expect(control.restrictions).toEqual([])
    }
  })

  test('returns exact history materialization and canonicalization failures without defecting', async () => {
    const materializationDefect = new Error('hostile broker order asset access')
    const hostileOrder = Object.defineProperty({ ...order(0) }, 'assetId', {
      enumerable: true,
      get: () => {
        throw materializationDefect
      },
    }) as BrokerOrder
    const malformedOrder = { ...order(1), clientOrderId: '\ud800' }

    const cases = [
      {
        input: hostileOrder,
        expected: {
          message: 'broker before history materialization failed',
          cause: materializationDefect,
          error: { _tag: 'HistoryMaterializationFailed', cause: materializationDefect },
        },
      },
      {
        input: malformedOrder,
        expected: {
          message: 'broker before history canonicalization failed',
          cause: {
            _tag: 'CanonicalJsonFailure',
            path: '$.orders[0].clientOrderId',
            reason: 'invalid-unicode-surrogate',
            actualType: 'string',
          },
          error: {
            _tag: 'HistoryCanonicalizationFailed',
            cause: {
              _tag: 'CanonicalJsonFailure',
              path: '$.orders[0].clientOrderId',
              reason: 'invalid-unicode-surrogate',
              actualType: 'string',
            },
          },
        },
      },
    ] as const

    for (const testCase of cases) {
      const read: BrokerReadShape = {
        ...emptyRead(),
        orders: () => Effect.succeed({ value: [testCase.input], evidence: evidence('hostile-order') }),
      }
      const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

      const failure = await Effect.runPromise(provide(read, makeStore(control)).pipe(Effect.flip))

      expect(failure).toMatchObject({
        _tag: 'ReconciliationError',
        operation: 'snapshot',
        message: testCase.expected.message,
        cause: testCase.expected.cause,
        failure: {
          _tag: 'HistoryHash',
          side: 'before',
          error: testCase.expected.error,
        },
      })
      expect(control.writes).toBe(0)
      expect(control.reconciliations).toEqual([])
      expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
    }
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
      failure: {
        _tag: 'Pagination',
        reason: 'FillHistoryTooLarge',
      },
    })
    expect(offset).toBe(10_001)
    expect(control.writes).toBe(0)
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('keeps persistence and containment in distinct writer-fence transactions', async () => {
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    const transactionEvents: string[] = []
    let transactionDepth = 0
    const writerFence: WriterFenceService = {
      check: Effect.void,
      transaction: (effect) =>
        Effect.sync(() => {
          transactionDepth += 1
          transactionEvents.push('begin')
        }).pipe(
          Effect.andThen(effect),
          Effect.ensuring(
            Effect.sync(() => {
              transactionEvents.push('end')
              transactionDepth -= 1
            }),
          ),
        ),
    }
    const insideTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.sync(() => {
        expect(transactionDepth).toBe(1)
      }).pipe(Effect.andThen(effect))
    const baseStore = makeStore(control)
    const persistenceFailure = new ExecutionStoreError({
      operation: 'reconciliation',
      failure: 'query',
      message: 'injected reconciliation write failure',
    })
    const store: TestStore = {
      ...baseStore,
      ingest: (input) => insideTransaction(baseStore.ingest(input)),
      retainCashReporting: (input) => insideTransaction(baseStore.retainCashReporting(input)),
      ingestPositions: (input) => insideTransaction(baseStore.ingestPositions(input)),
      completeHistory: (inputs) => insideTransaction(baseStore.completeHistory(inputs)),
      account: (input) => insideTransaction(baseStore.account(input)),
      verifyCompleted: (inputs) => insideTransaction(baseStore.verifyCompleted(inputs)),
      value: (input) => insideTransaction(baseStore.value(input)),
      hasAccountBaseline: (id) =>
        Effect.sync(() => expect(transactionDepth).toBe(0)).pipe(Effect.andThen(baseStore.hasAccountBaseline(id))),
      bindings: (id) =>
        Effect.sync(() => expect(transactionDepth).toBe(0)).pipe(Effect.andThen(baseStore.bindings(id))),
      reconcile: (_, snapshot) =>
        writerFence.transaction(insideTransaction(snapshot)).pipe(
          Effect.andThen(writerFence.transaction(insideTransaction(Effect.fail(persistenceFailure)))),
          Effect.mapError(() => persistenceFailure),
        ),
      restrictAuthority: (reason, updatedAt) => insideTransaction(baseStore.restrictAuthority(reason, updatedAt)),
    }

    const exit = await Effect.runPromiseExit(provide(emptyRead(), store, writerFence))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failures = exit.cause.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [reason.error] : []))
      expect(failures).toEqual([persistenceFailure])
    }
    expect(transactionEvents).toEqual(Array.from({ length: 3 }, () => ['begin', 'end']).flat())
    expect(transactionDepth).toBe(0)
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
  })

  test('retains both causes when authority restriction fails', async () => {
    const primaryFailure = new BrokerReadError({
      operation: 'account',
      kind: BrokerReadErrorKind.InvalidResponse,
      message: 'injected non-retryable read failure',
      retryable: false,
    })
    const containmentFailure = new ExecutionStoreError({
      operation: 'authority',
      failure: 'query',
      message: 'injected authority restriction failure',
    })
    const read: BrokerReadShape = {
      ...emptyRead(),
      account: Effect.fail(primaryFailure),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }
    let restrictionAttempts = 0
    const store: TestStore = {
      ...makeStore(control),
      restrictAuthority: () =>
        Effect.sync(() => {
          restrictionAttempts += 1
        }).pipe(Effect.andThen(Effect.fail(containmentFailure))),
    }
    let transactions = 0
    const writerFence: WriterFenceService = {
      check: Effect.void,
      transaction: (effect) =>
        Effect.sync(() => {
          transactions += 1
        }).pipe(Effect.andThen(effect)),
    }

    const exit = await Effect.runPromiseExit(provide(read, store, writerFence))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failures = exit.cause.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [reason.error] : []))
      const containmentErrors = failures.filter(
        (failure): failure is ReconciliationError =>
          failure instanceof ReconciliationError && failure.failure?._tag === 'AuthorityRestrictionFailed',
      )
      expect(containmentErrors).toHaveLength(1)
      const containmentError = containmentErrors[0]
      if (containmentError?.failure?._tag !== 'AuthorityRestrictionFailed') {
        throw new Error('expected an authority restriction failure')
      }
      const reconciliationFailures = containmentError.failure.reconciliationCause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) ? [reason.error] : [],
      )
      const restrictionFailures = containmentError.failure.restrictionCause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) ? [reason.error] : [],
      )
      expect(reconciliationFailures).toContain(primaryFailure)
      expect(restrictionFailures).toContain(containmentFailure)
    }
    expect(restrictionAttempts).toBe(1)
    expect(transactions).toBe(1)
    expect(control.reconciliations).toEqual([])
  })

  test('propagates a defect after successful authority restriction', async () => {
    const defect = new Error('unexpected reconciliation defect')
    const read: BrokerReadShape = {
      ...emptyRead(),
      account: Effect.die(defect),
    }
    const control: StoreControl = { writes: 0, reconciliations: [], restrictions: [] }

    const exit = await Effect.runPromiseExit(provide(read, makeStore(control)))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const defects = exit.cause.reasons.flatMap((reason) => (Cause.isDieReason(reason) ? [reason.defect] : []))
      expect(defects).toContain(defect)
    }
    expect(control.restrictions).toEqual(['reconciliation pass incomplete'])
    expect(control.reconciliations).toEqual([])
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
