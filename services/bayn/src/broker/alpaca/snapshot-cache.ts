import { Config, DateTime, Effect, Exit, Schema, Semaphore } from 'effect'

import { readBrokerSnapshotOnce } from '../../simulation-reconciliation/broker-history'
import { currentUtcInstant } from '../../time'
import { BrokerReadError, configurationError } from './failures'
import { OrderCollection, SortDirection, type BrokerHistory, type BrokerReadShape } from './model'
import {
  BrokerObservations,
  maximumBrokerObservationAgeMs,
  observationTimes,
  observationUnavailable,
  type ObservedBrokerSnapshot,
  type BrokerObservationTicket,
} from './observed-snapshot'

export interface BrokerSnapshotCacheConfig {
  readonly pollIntervalMs: number
  readonly maxAgeMs: number
}
const interval = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: maximumBrokerObservationAgeMs }))
export const brokerSnapshotCacheConfig: Effect.Effect<BrokerSnapshotCacheConfig, BrokerReadError> = Config.all({
  pollIntervalMs: Config.schema(interval, 'BAYN_BROKER_POLL_INTERVAL_MS').pipe(Config.withDefault(10_000)),
  maxAgeMs: Config.schema(interval, 'BAYN_BROKER_CACHE_MAX_AGE_MS').pipe(
    Config.withDefault(maximumBrokerObservationAgeMs),
  ),
}).pipe(
  Effect.mapError((cause) =>
    configurationError({ operation: 'configuration', message: 'Invalid broker cache configuration', cause }),
  ),
  Effect.flatMap((config) =>
    config.maxAgeMs <= config.pollIntervalMs
      ? Effect.fail(
          configurationError({
            operation: 'configuration',
            message: 'Broker cache maximum age must exceed its poll interval',
          }),
        )
      : Effect.succeed(config),
  ),
)

export const makeBrokerObservationCapture = Effect.gen(function* () {
  const permit = yield* Semaphore.make(1)
  let previous:
    | { readonly history: BrokerHistory; readonly completedAt: string; readonly generation: number }
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
          if (
            previous !== undefined &&
            (previous.completedAt > startedAt || ticket.generation !== previous.generation + 1)
          )
            previous = undefined
          yield* Effect.annotateCurrentSpan('broker.history.reused', previous !== undefined)
          const value = yield* Effect.all(
            {
              // Restart unstable cuts through the owner, with a new durable ticket and the existing quota wait.
              // Retrying under a ticket invalidated by that mutation only adds unusable history reads and debt.
              snapshot: readBrokerSnapshotOnce(fresh, currentUtcInstant, previous?.history),
              configuration: fresh.accountConfiguration,
              openOrders: fresh.orders({ status: OrderCollection.Open, limit: 1 }),
              recentOrders: fresh.orders({
                status: OrderCollection.All,
                limit: 1,
                direction: SortDirection.Descending,
              }),
              recentFills: fresh.fillActivities({ pageSize: 1, direction: SortDirection.Descending }),
            },
            { concurrency: 2 },
          )
          const completedAt = yield* currentUtcInstant
          const candidate = { ...value, startedAt, completedAt, observedAt: startedAt }
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
              previous = Exit.isSuccess(exit)
                ? {
                    history: exit.value.snapshot.history,
                    completedAt: exit.value.completedAt,
                    generation: ticket.generation,
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
            : observationUnavailable('Broker polling could not establish a stable history', cause),
        ),
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(observationUnavailable('Broker observation polling exceeded its deadline')),
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
        snapshot: observations.read.pipe(Effect.map((value) => value.snapshot)),
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
