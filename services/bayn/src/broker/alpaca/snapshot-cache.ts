import { isDeepStrictEqual } from 'node:util'
import { Config, DateTime, Effect, Exit, Result, Schema, Semaphore } from 'effect'

import { readBrokerSnapshotOnce, readFeePages } from '../../simulation-reconciliation/broker-history'
import { ordersPageSize } from '../../simulation-reconciliation/broker-reconciler-model'
import { currentUtcInstant } from '../../time'
import { pendingCashFees } from './activity-fees'
import { BrokerPollFailureReason, BrokerReadError, configurationError } from './failures'
import {
  OrderCollection,
  OrderStatus,
  SortDirection,
  type BrokerHistory,
  type BrokerReadShape,
  type FeeActivity,
  type Observed,
  type Order,
  type ReadResult,
} from './model'
import {
  BrokerObservations,
  maximumBrokerObservationAgeMs,
  observationTimes,
  observationUnavailable,
  type ObservedBrokerSnapshot,
  type BrokerObservationTicket,
} from './observed-snapshot'

export interface BrokerSnapshotCacheConfig {
  readonly maxAgeMs: number
}
const interval = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: maximumBrokerObservationAgeMs }))
export const brokerSnapshotCacheConfig: Effect.Effect<BrokerSnapshotCacheConfig, BrokerReadError> = Config.all({
  maxAgeMs: Config.schema(interval, 'BAYN_BROKER_CACHE_MAX_AGE_MS').pipe(
    Config.withDefault(maximumBrokerObservationAgeMs),
  ),
}).pipe(
  Effect.mapError((cause) =>
    configurationError({ operation: 'configuration', message: 'Invalid broker cache configuration', cause }),
  ),
)

const openOrder = (order: Order) =>
  ![OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected].includes(order.status)
const orderContent = ({ observedAt: _readClock, legs: _nested, ...order }: Order) => order
const unavailableOpenOrders = (message: string) =>
  Result.fail(observationUnavailable(message, undefined, BrokerPollFailureReason.SnapshotRejected))

/** The full history supplies nested lineage, never invented group metadata or an alternative open-order read. */
const completeOpenOrders = (read: ReadResult<readonly Order[]>, history: BrokerHistory['orders']) =>
  Result.gen(function* () {
    // Alpaca counts parent and child rows toward its page limit. A saturated page cannot prove completeness.
    if (read.value.reduce((count, order) => count + 1 + (order.legs?.length ?? 0), 0) >= ordersPageSize)
      return yield* unavailableOpenOrders('Open broker order page does not prove complete coverage')
    const historyChildren = new Map<string, Order>()
    for (const { value: parent } of history.rows) {
      for (const child of parent.legs ?? []) {
        if (child.parentBrokerOrderId !== parent.brokerOrderId || historyChildren.has(child.brokerOrderId))
          return yield* unavailableOpenOrders('Broker history contains conflicting protection child identities')
        historyChildren.set(child.brokerOrderId, child)
      }
    }
    const index = (rows: readonly Order[]) =>
      Result.gen(function* () {
        const indexed = new Map<string, { readonly order: Order; readonly nested: boolean }>()
        const topIds = new Set<string>()
        const clients = new Map<string, string>()
        for (const parent of rows) {
          if (topIds.has(parent.brokerOrderId))
            return yield* unavailableOpenOrders('Broker order response repeats a top-level identity')
          topIds.add(parent.brokerOrderId)
          for (const [position, candidate] of [parent, ...(parent.legs ?? [])].entries()) {
            const nested = position > 0
            if (nested && (candidate.parentBrokerOrderId !== parent.brokerOrderId || candidate.legs !== undefined))
              return yield* unavailableOpenOrders('Broker order response contains invalid nested protection lineage')
            const known = historyChildren.get(candidate.brokerOrderId)
            const { legs: _children, ...leaf } = candidate
            const order =
              known?.parentBrokerOrderId !== undefined && leaf.parentBrokerOrderId === undefined
                ? { ...leaf, parentBrokerOrderId: known.parentBrokerOrderId }
                : leaf
            if (known !== undefined && !isDeepStrictEqual(orderContent(known), orderContent(order)))
              return yield* unavailableOpenOrders('Open protection child differs from the complete broker history')
            const previous = indexed.get(order.brokerOrderId)
            if (
              previous !== undefined &&
              (previous.nested === nested || !isDeepStrictEqual(orderContent(previous.order), orderContent(order)))
            )
              return yield* unavailableOpenOrders('Broker order response contains duplicate or conflicting identities')
            const clientOwner = clients.get(order.clientOrderId)
            if (clientOwner !== undefined && clientOwner !== order.brokerOrderId)
              return yield* unavailableOpenOrders('Broker order response repeats a client identity')
            clients.set(order.clientOrderId, order.brokerOrderId)
            indexed.set(order.brokerOrderId, { order, nested })
          }
        }
        return new Map([...indexed].filter(([, { order }]) => openOrder(order)).map(([id, { order }]) => [id, order]))
      })
    const expected = yield* index(history.rows.map(({ value }) => value))
    const observed = yield* index(read.value)
    if (
      expected.size !== observed.size ||
      [...observed].some(([id, order]) => {
        const known = expected.get(id)
        return known === undefined || !isDeepStrictEqual(orderContent(known), orderContent(order))
      })
    )
      return yield* unavailableOpenOrders('Open broker orders differ from the complete broker history')
    return { ...read, value: [...observed.values()] }
  })

export const makeBrokerObservationCapture = Effect.gen(function* () {
  const permit = yield* Semaphore.make(1)
  let previous:
    | {
        readonly history: BrokerHistory
        readonly completedAt: string
        readonly generation: number
        readonly latestFillId: string | null
      }
    | undefined
  let verifiedFees: { readonly feeVersion: string; readonly rows: readonly Observed<FeeActivity>[] } | undefined
  return (
    fresh: BrokerReadShape,
    ticket: BrokerObservationTicket,
    timeoutMs: number,
  ): Effect.Effect<ObservedBrokerSnapshot, BrokerReadError> =>
    permit
      .withPermit(
        Effect.gen(function* () {
          const { startedAt } = ticket
          const now = yield* currentUtcInstant
          if (
            previous !== undefined &&
            (previous.completedAt > startedAt ||
              previous.completedAt > now ||
              ticket.generation !== previous.generation + 1)
          )
            previous = undefined
          const accountActivity = fresh.accountActivity
          let sampledFees:
            | {
                readonly feeVersion: string
                readonly fees: readonly Observed<FeeActivity>[]
                readonly pendingCashFeeCount: number
              }
            | undefined
          const paperActivities =
            accountActivity === undefined
              ? undefined
              : Effect.gen(function* () {
                  const cut = yield* accountActivity
                  if (verifiedFees?.feeVersion === cut.feeVersion)
                    return { cut, fees: verifiedFees.rows, pendingCashFeeCount: 0 }
                  if (sampledFees?.feeVersion === cut.feeVersion) return { cut, ...sampledFees }
                  const fees = yield* readFeePages(fresh)
                  const confirmed = yield* accountActivity
                  const pendingCashFeeCount = pendingCashFees(cut.feeCounts, fees, startedAt)
                  if (confirmed.version !== cut.version || pendingCashFeeCount === undefined)
                    return yield* observationUnavailable(
                      'Alpaca Activity SSE and fee authority have not converged',
                      undefined,
                      BrokerPollFailureReason.SnapshotRejected,
                    )
                  if (pendingCashFeeCount === 0) verifiedFees = { feeVersion: cut.feeVersion, rows: fees }
                  sampledFees = { feeVersion: cut.feeVersion, fees, pendingCashFeeCount }
                  return { cut: confirmed, ...sampledFees }
                })
          if (previous !== undefined) {
            if (accountActivity === undefined) {
              const latest = yield* fresh.fillActivities({ pageSize: 1, direction: SortDirection.Descending })
              if (previous.latestFillId !== (latest.value.items[0]?.activityId ?? null)) previous = undefined
            } else {
              const cut = yield* accountActivity
              if (
                verifiedFees?.feeVersion !== cut.feeVersion ||
                previous.latestFillId !== (cut.fills.at(-1)?.value.activityId ?? null)
              )
                previous = undefined
            }
          }
          yield* Effect.annotateCurrentSpan('broker.history.reused', previous !== undefined)
          const value = yield* Effect.all(
            {
              // Restart unstable cuts through the owner, with a new durable ticket and the existing quota wait.
              // Retrying under a ticket invalidated by that mutation only adds unusable history reads and debt.
              capture: readBrokerSnapshotOnce(fresh, currentUtcInstant, previous?.history, paperActivities),
              configuration: fresh.accountConfiguration,
              openOrders: fresh.orders({ status: OrderCollection.Open, limit: ordersPageSize }),
            },
            { concurrency: 2 },
          )
          const completedAt = yield* currentUtcInstant
          const candidate = {
            ...value.capture,
            configuration: value.configuration,
            openOrders: yield* Effect.fromResult(
              completeOpenOrders(value.openOrders, value.capture.snapshot.history.orders),
            ),
            startedAt,
            completedAt,
            observedAt: startedAt,
          }
          const observedAt = DateTime.formatIso(
            DateTime.makeUnsafe(
              Math.min(
                ...[...observationTimes(candidate), candidate.snapshot.history.orders.observedAt].map(Date.parse),
              ),
            ),
          )
          return { ...candidate, observedAt }
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              // A completed full after-read brackets the next account read. Never retain a partial or failed cut.
              previous =
                Exit.isSuccess(exit) && exit.value.pendingCashFeeCount === 0
                  ? {
                      history: exit.value.snapshot.history,
                      completedAt: exit.value.completedAt,
                      generation: ticket.generation,
                      latestFillId: exit.value.recentFills.value.items[0]?.activityId ?? null,
                    }
                  : undefined
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof BrokerReadError
            ? cause
            : observationUnavailable(
                'Broker polling could not establish a stable history',
                cause,
                BrokerPollFailureReason.SnapshotRejected,
              ),
        ),
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              observationUnavailable(
                'Broker observation polling exceeded its deadline',
                undefined,
                BrokerPollFailureReason.PollDeadline,
              ),
            ),
        }),
        Effect.withSpan('broker.observation.poll'),
      )
})

export const makeProjectedBrokerRead = (
  fresh: BrokerReadShape,
): Effect.Effect<BrokerReadShape, never, BrokerObservations> =>
  Effect.map(BrokerObservations, (observations) => {
    const cached = observations.readState
    const invalidate = observations.invalidate.pipe(Effect.orDie)
    return {
      ...fresh,
      projection: {
        healthSnapshot: cached,
        fresh,
        invalidate,
        reconciliationSnapshot: observations.readForReconciliation.pipe(
          Effect.map(({ observation, complete }) => ({ snapshot: observation.snapshot, complete })),
        ),
        submissionSnapshot: (intentId) =>
          observations.readForSubmit(intentId).pipe(
            Effect.map((value) => ({
              account: value.snapshot.account,
              positions: value.snapshot.positions,
              openOrders: value.openOrders,
            })),
          ),
        withMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          invalidate.pipe(Effect.andThen(effect), Effect.ensuring(invalidate)),
      },
      account: cached.pipe(Effect.map((value) => value.snapshot.account)),
      positions: cached.pipe(Effect.map((value) => value.snapshot.positions)),
      accountConfiguration: cached.pipe(Effect.map((value) => value.configuration)),
      orders: (query) => {
        const { status, limit, direction, ...filters } = query ?? {}
        if (Object.keys(filters).length === 0 && limit !== undefined) {
          if (status === OrderCollection.Open && direction === undefined)
            return cached.pipe(
              Effect.map((value) => ({ ...value.openOrders, value: value.openOrders.value.slice(0, limit) })),
            )
          if (status === OrderCollection.All && limit === 1 && direction === SortDirection.Descending)
            return cached.pipe(Effect.map((value) => value.recentOrders))
        }
        return fresh.orders(query)
      },
      fillActivities: (query) => {
        const { pageSize, direction, ...filters } = query ?? {}
        return Object.keys(filters).length === 0 && pageSize === 1 && direction === SortDirection.Descending
          ? cached.pipe(Effect.map((value) => value.recentFills))
          : fresh.fillActivities(query)
      },
    }
  })
