import { Cause, Clock, Data, Duration, Effect, Schedule } from 'effect'

import {
  BrokerRead,
  OrderCollection,
  SortDirection,
  type BrokerReadError,
  type BrokerReadShape,
  type FillActivity,
  type Order as BrokerOrder,
  type ReadEvidence,
} from './broker/alpaca'
import {
  accountObservation,
  fillObservation,
  orderObservation,
  positionSnapshot,
  sourceTimestamp,
  type BrokerEventInput,
  type FillEventInput,
} from './broker/observations'
import { PaperStore, type PaperStoreError, type PaperStoreShape } from './db/paper-store'
import type { BrokerSnapshot, ReconciliationReport } from './db/reconciliation'
import { WriterFence, type WriterFenceError, type WriterFenceService } from './execution/writer-fence'
import { canonicalHashV1 } from './hash'
import type { ReconciledBrokerState, ReconciliationRiskContext } from './reconciliation'

const maximumRows = 10_000
const ordersPageSize = 500
const fillsPageSize = 100

interface Observed<A> {
  readonly value: A
  readonly evidence: ReadEvidence
}

interface OrderRead {
  readonly rows: readonly Observed<BrokerOrder>[]
  readonly observedAt: string
}

interface BrokerHistory {
  readonly orders: OrderRead
  readonly fills: readonly Observed<FillActivity>[]
}

export interface ReconciliationPassResult {
  readonly report: ReconciliationReport
  readonly brokerState: ReconciledBrokerState
  readonly riskContext: ReconciliationRiskContext
}

export class ReconciliationError extends Data.TaggedError('ReconciliationError')<{
  readonly operation: 'pagination' | 'normalization' | 'snapshot'
  readonly message: string
  readonly cause?: unknown
}> {}

const failure = (operation: ReconciliationError['operation'], message: string, cause?: unknown): ReconciliationError =>
  new ReconciliationError({ operation, message, cause })

const attempt = <A>(operation: ReconciliationError['operation'], message: string, evaluate: () => A) =>
  Effect.try({ try: evaluate, catch: (cause) => failure(operation, message, cause) })

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const readOrders = (
  read: BrokerReadShape,
  until: string,
): Effect.Effect<OrderRead, BrokerReadError | ReconciliationError> =>
  Effect.gen(function* () {
    const rows: Observed<BrokerOrder>[] = []
    const ids = new Set<string>()
    let cursor: string | undefined
    let previousSubmittedAt: string | undefined
    let observedAt: string | undefined

    while (true) {
      const limit = Math.min(ordersPageSize, maximumRows + 1 - rows.length)
      const page = yield* read.orders({
        status: OrderCollection.All,
        direction: SortDirection.Ascending,
        limit,
        until,
        ...(cursor === undefined ? {} : { after: cursor }),
      })
      observedAt =
        observedAt === undefined || page.evidence.observedAt > observedAt ? page.evidence.observedAt : observedAt
      if (page.value.length > limit) {
        return yield* Effect.fail(failure('pagination', 'Alpaca returned more orders than requested'))
      }
      if (page.value.length === 0) return { rows, observedAt }

      for (const order of page.value) {
        const submittedAt = order.submittedAt
        if (submittedAt === undefined) {
          return yield* Effect.fail(
            failure('pagination', `Alpaca order ${order.brokerOrderId} is missing submitted_at`),
          )
        }
        if (previousSubmittedAt !== undefined && sourceTimestamp(submittedAt) < sourceTimestamp(previousSubmittedAt)) {
          return yield* Effect.fail(failure('pagination', 'Alpaca order history is not ascending'))
        }
        if (cursor !== undefined && sourceTimestamp(submittedAt) <= sourceTimestamp(cursor)) {
          return yield* Effect.fail(failure('pagination', 'Alpaca order timestamp cursor did not advance'))
        }
        if (ids.has(order.brokerOrderId)) {
          return yield* Effect.fail(failure('pagination', `duplicate Alpaca order ${order.brokerOrderId}`))
        }
        ids.add(order.brokerOrderId)
        rows.push({ value: order, evidence: page.evidence })
        previousSubmittedAt = submittedAt
        if (rows.length > maximumRows) {
          return yield* Effect.fail(failure('pagination', `Alpaca order history exceeds ${maximumRows} rows`))
        }
      }

      if (page.value.length < limit) return { rows, observedAt }
      const next = page.value[page.value.length - 1]?.submittedAt
      if (next === undefined || next === cursor) {
        return yield* Effect.fail(failure('pagination', 'Alpaca order cursor did not advance'))
      }
      cursor = next
    }
  })

const readFills = (
  read: BrokerReadShape,
  until: string,
): Effect.Effect<readonly Observed<FillActivity>[], BrokerReadError | ReconciliationError> =>
  Effect.gen(function* () {
    const rows: Observed<FillActivity>[] = []
    const ids = new Set<string>()
    let cursor: string | undefined

    while (true) {
      const pageSize = Math.min(fillsPageSize, maximumRows + 1 - rows.length)
      const page = yield* read.fillActivities({
        direction: SortDirection.Ascending,
        pageSize,
        until,
        ...(cursor === undefined ? {} : { pageToken: cursor }),
      })
      if (page.value.items.length > pageSize) {
        return yield* Effect.fail(failure('pagination', 'Alpaca returned more fills than requested'))
      }

      for (const fill of page.value.items) {
        if (ids.has(fill.activityId)) {
          return yield* Effect.fail(failure('pagination', `duplicate Alpaca fill ${fill.activityId}`))
        }
        ids.add(fill.activityId)
        rows.push({ value: fill, evidence: page.evidence })
        if (rows.length > maximumRows) {
          return yield* Effect.fail(failure('pagination', `Alpaca fill history exceeds ${maximumRows} rows`))
        }
      }

      const next = page.value.nextPageToken
      if (next === undefined) return rows
      const last = page.value.items[page.value.items.length - 1]?.activityId
      if (page.value.items.length === 0 || next === cursor || next !== last) {
        return yield* Effect.fail(failure('pagination', 'Alpaca fill cursor did not advance'))
      }
      cursor = next
    }
  })

const readHistory = (
  read: BrokerReadShape,
  until: string,
): Effect.Effect<BrokerHistory, BrokerReadError | ReconciliationError> =>
  Effect.all({ orders: readOrders(read, until), fills: readFills(read, until) }, { concurrency: 2 })

const historyHash = (history: BrokerHistory): string =>
  canonicalHashV1({
    schemaVersion: 'bayn.paper-broker-history.v1',
    orders: history.orders.rows
      .map(({ value }) => {
        const { observedAt: _observedAt, ...material } = value
        return material
      })
      .sort((left, right) => left.brokerOrderId.localeCompare(right.brokerOrderId)),
    fills: history.fills
      .map(({ value }) => value)
      .sort((left, right) => left.activityId.localeCompare(right.activityId)),
  })

const run = (
  read: BrokerReadShape,
  store: PaperStoreShape,
  fence: WriterFenceService,
): Effect.Effect<
  ReconciliationPassResult,
  BrokerReadError | PaperStoreError | ReconciliationError | WriterFenceError
> =>
  Effect.gen(function* () {
    const beforeUntil = new Date(yield* Clock.currentTimeMillis).toISOString()
    const before = yield* readHistory(read, beforeUntil)
    const [accountResult, positionsResult] = yield* Effect.all([read.account, read.positions], { concurrency: 2 })
    const afterUntil = new Date(yield* Clock.currentTimeMillis).toISOString()
    const history = yield* readHistory(read, afterUntil)
    if (historyHash(before) !== historyHash(history)) {
      return yield* Effect.fail(failure('snapshot', 'broker history changed during reconciliation'))
    }
    const { orders, fills } = history

    return yield* fence.transaction(
      Effect.gen(function* () {
        const bindings = yield* store.bindings(accountResult.value.id)
        if (fills.length > 0 && !(yield* store.hasAccountBaseline(accountResult.value.id))) {
          return yield* Effect.fail(
            failure('snapshot', 'paper account has fill history before Bayn established an opening cash baseline'),
          )
        }

        const normalized = yield* attempt('normalization', 'broker snapshot normalization failed', () => {
          const intentByClient = new Map<string, string>()
          for (const binding of bindings) {
            if (intentByClient.has(binding.clientOrderId)) {
              throw new Error(`duplicate intent client order ID ${binding.clientOrderId}`)
            }
            intentByClient.set(binding.clientOrderId, binding.intentId)
          }

          const orderById = new Map<string, BrokerOrder>()
          const clientOrderIds = new Set<string>()
          const orderEvents: Extract<BrokerEventInput, { readonly _tag: 'Order' }>[] = []
          for (const observed of orders.rows) {
            if (orderById.has(observed.value.brokerOrderId)) {
              throw new Error(`duplicate broker order ID ${observed.value.brokerOrderId}`)
            }
            if (clientOrderIds.has(observed.value.clientOrderId)) {
              throw new Error(`duplicate broker client order ID ${observed.value.clientOrderId}`)
            }
            orderById.set(observed.value.brokerOrderId, observed.value)
            clientOrderIds.add(observed.value.clientOrderId)
            const event = orderObservation(
              observed.value,
              observed.evidence,
              intentByClient.get(observed.value.clientOrderId),
            )
            if (event._tag !== 'Order') throw new Error('normalized order event is not an order')
            orderEvents.push(event)
          }

          const fillEvents = [...fills]
            .sort((left, right) => {
              const byTime = compareText(
                sourceTimestamp(left.value.transactionTime),
                sourceTimestamp(right.value.transactionTime),
              )
              return byTime === 0 ? compareText(left.value.activityId, right.value.activityId) : byTime
            })
            .map((observed): FillEventInput => {
              const order = orderById.get(observed.value.brokerOrderId)
              if (order === undefined) {
                throw new Error(`Alpaca fill ${observed.value.activityId} references a missing order`)
              }
              return fillObservation(observed.value, order, observed.evidence, {
                intentId: intentByClient.get(order.clientOrderId),
              })
            })

          const accountEvent = accountObservation(accountResult)
          if (accountEvent._tag !== 'Account') throw new Error('normalized account event is not an account')
          return {
            account: accountEvent,
            positions: positionSnapshot(accountResult.value.id, positionsResult),
            orderEvents,
            fillEvents,
          }
        })

        const accountReceipt = yield* store.ingest(normalized.account)
        const positionsReceipt = yield* store.ingestPositions(normalized.positions)
        yield* Effect.forEach(normalized.orderEvents, store.ingest, { discard: true })
        yield* Effect.forEach(normalized.fillEvents, store.account, { discard: true })
        const valuation = yield* store.value({
          accountEventId: accountReceipt.eventId,
          positionSnapshotId: positionsReceipt.snapshotId,
        })
        const reconciledAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        const positions = normalized.positions.positions
          .map((event) => event.position)
          .sort((left, right) => compareText(left.symbol, right.symbol))
        const reconciledOrders = normalized.orderEvents
          .map((event) => event.order)
          .sort((left, right) => compareText(left.brokerOrderId, right.brokerOrderId))
        const unknownOrderCount = reconciledOrders.filter((order) => order.intentId === undefined).length
        const persisted = yield* store.reconcile({
          account: normalized.account.account,
          positions,
          positionsObservedAt: normalized.positions.observedAt,
          orders: reconciledOrders,
          ordersObservedAt: orders.observedAt,
          fills: normalized.fillEvents.map((event) => event.fill),
          valuation,
          reconciledAt,
        } satisfies BrokerSnapshot)
        const report: ReconciliationReport = {
          reconciliation: persisted.reconciliation,
          metrics: persisted.metrics,
        }
        const brokerState: ReconciledBrokerState = {
          account: normalized.account.account,
          positions,
          positionsObservedAt: normalized.positions.observedAt,
          orders: reconciledOrders,
          ordersObservedAt: orders.observedAt,
          accountingHash: persisted.accountingHash,
          reconciliation: persisted.reconciliation,
          unknownOrderCount,
        }

        yield* Effect.logInfo('Paper account reconciliation completed').pipe(
          Effect.annotateLogs({
            accountId: report.reconciliation.accountId,
            status: report.reconciliation.status,
            reconciliationId: report.reconciliation.reconciliationId,
            orderCount: normalized.orderEvents.length,
            fillCount: normalized.fillEvents.length,
            discrepancyCount: report.metrics.discrepancyCount,
            brokerPollAgeMs: report.metrics.brokerPollAgeMs,
            oldestUnknownMutationAgeMs: report.metrics.oldestUnknownMutationAgeMs,
            accountingExact: report.metrics.accountingExact,
          }),
        )
        return { report, brokerState, riskContext: persisted.riskContext }
      }),
    )
  }).pipe(Effect.withLogSpan('reconciliation'))

export const runOnce: Effect.Effect<
  ReconciliationPassResult,
  BrokerReadError | PaperStoreError | ReconciliationError | WriterFenceError,
  BrokerRead | PaperStore | WriterFence
> = Effect.gen(function* () {
  const read = yield* BrokerRead
  const store = yield* PaperStore
  const fence = yield* WriterFence
  const restrict = Effect.gen(function* () {
    const failedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    yield* fence.transaction(store.restrictAuthority('reconciliation pass incomplete', failedAt))
  })
  return yield* run(read, store, fence).pipe(
    Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : restrict)),
  )
})

export const runContinuously = (interval: Duration.Input) =>
  runOnce.pipe(
    Effect.tapError((error) =>
      Effect.logError('Paper account reconciliation failed; authority is restricted to OBSERVE').pipe(
        Effect.annotateLogs({ errorTag: error._tag, operation: error.operation }),
      ),
    ),
    Effect.catch(() => Effect.void),
    Effect.repeat(Schedule.spaced(interval)),
    Effect.asVoid,
  )
