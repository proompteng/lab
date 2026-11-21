import { Config, DateTime, Effect, Exit, Schema, Semaphore } from 'effect'

import { readBrokerSnapshotOnce, readFeePages } from '../../simulation-reconciliation/broker-history'
import { currentUtcInstant } from '../../time'
import { pendingCashFees } from './activity-fees'
import { BrokerPollFailureReason, BrokerReadError, configurationError } from './failures'
import {
  OrderCollection,
  SortDirection,
  type BrokerHistory,
  type BrokerReadShape,
  type FeeActivity,
  type Observed,
} from './model'
import {
  BrokerObservations,
  maximumBrokerObservationAgeMs,
  observationTimes,
  observationUnavailable,
  requireSettledCashFees,
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
  let verifiedFees:
    | { readonly counts: ReadonlyMap<string, number>; readonly rows: readonly Observed<FeeActivity>[] }
    | undefined
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
                readonly counts: ReadonlyMap<string, number>
                readonly fees: readonly Observed<FeeActivity>[]
                readonly pendingCashFeeCount: number
              }
            | undefined
          const paperActivities =
            accountActivity === undefined
              ? undefined
              : Effect.gen(function* () {
                  const cut = yield* accountActivity
                  if (verifiedFees?.counts === cut.feeCounts)
                    return { cut, fees: verifiedFees.rows, pendingCashFeeCount: 0 }
                  if (sampledFees?.counts === cut.feeCounts) return { cut, ...sampledFees }
                  const fees = yield* readFeePages(fresh)
                  const confirmed = yield* accountActivity
                  const pendingCashFeeCount = pendingCashFees(cut.feeCounts, fees, startedAt)
                  if (confirmed.feeCounts !== cut.feeCounts || pendingCashFeeCount === undefined)
                    return yield* observationUnavailable(
                      'Alpaca Activity SSE and fee authority have not converged',
                      undefined,
                      BrokerPollFailureReason.SnapshotRejected,
                    )
                  if (pendingCashFeeCount === 0) verifiedFees = { counts: cut.feeCounts, rows: fees }
                  sampledFees = { counts: cut.feeCounts, fees, pendingCashFeeCount }
                  return { cut: confirmed, ...sampledFees }
                })
          if (previous !== undefined) {
            if (accountActivity === undefined) {
              const latest = yield* fresh.fillActivities({ pageSize: 1, direction: SortDirection.Descending })
              if (previous.latestFillId !== (latest.value.items[0]?.activityId ?? null)) previous = undefined
            } else {
              const cut = yield* accountActivity
              if (
                verifiedFees?.counts !== cut.feeCounts ||
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
              openOrders: fresh.orders({ status: OrderCollection.Open, limit: 1 }),
            },
            { concurrency: 2 },
          )
          const completedAt = yield* currentUtcInstant
          const candidate = {
            ...value.capture,
            configuration: value.configuration,
            openOrders: value.openOrders,
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
        healthSnapshot: cached.pipe(Effect.tap(requireSettledCashFees)),
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
              Effect.flatMap((value) =>
                value.openOrders.value.length >= 1 && limit > 1
                  ? Effect.fail(observationUnavailable('Broker observation contains an active order'))
                  : Effect.succeed(value.openOrders),
              ),
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
