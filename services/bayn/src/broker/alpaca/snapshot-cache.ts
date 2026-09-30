import { Clock, Config, DateTime, Effect, Ref, Schema, type Scope } from 'effect'

import { readStableBrokerSnapshot } from '../../simulation-reconciliation/broker-history'
import { ReconciliationError } from '../../simulation-reconciliation/broker-reconciler-model'
import { currentUtcInstant } from '../../time'
import { BrokerReadError, BrokerReadErrorKind, configurationError, safeCause } from './failures'
import {
  OrderCollection,
  SortDirection,
  type AccountConfigurationObservation,
  type BrokerReadShape,
  type FillActivityPage,
  type Order,
  type ReadResult,
  type StableBrokerSnapshot,
} from './model'

export interface BrokerSnapshotCacheConfig {
  readonly pollIntervalMs: number
  readonly maxAgeMs: number
}

const interval = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60_000 }))

export const brokerSnapshotCacheConfig: Effect.Effect<BrokerSnapshotCacheConfig, BrokerReadError> = Config.all({
  pollIntervalMs: Config.schema(interval, 'BAYN_BROKER_POLL_INTERVAL_MS').pipe(Config.withDefault(30_000)),
  maxAgeMs: Config.schema(interval, 'BAYN_BROKER_CACHE_MAX_AGE_MS').pipe(Config.withDefault(60_000)),
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

interface CachedSnapshot {
  readonly snapshot: StableBrokerSnapshot
  readonly configuration: ReadResult<AccountConfigurationObservation>
  readonly openOrders: ReadResult<readonly Order[]>
  readonly recentOrders: ReadResult<readonly Order[]>
  readonly recentFills: ReadResult<FillActivityPage>
  readonly observedAtMs: number
}

type CacheState =
  | { readonly _tag: 'Invalidated'; readonly generation: number }
  | { readonly _tag: 'Ready'; readonly generation: number; readonly value: CachedSnapshot }
  | { readonly _tag: 'Failed'; readonly generation: number; readonly error: BrokerReadError }

const unavailable = (message: string) =>
  new BrokerReadError({
    operation: 'preflight',
    kind: BrokerReadErrorKind.Timeout,
    retryable: true,
    message,
  })

const snapshotError = (cause: ReconciliationError): BrokerReadError =>
  new BrokerReadError({
    operation: 'preflight',
    kind: BrokerReadErrorKind.InvalidResponse,
    retryable:
      cause.failure?._tag === 'Snapshot' &&
      (cause.failure.reason === 'HistoryChanged' || cause.failure.reason === 'FillActivitiesPending'),
    message: 'Broker snapshot polling could not establish a stable history',
    cause,
  })

const openOrdersQuery = { status: OrderCollection.Open, limit: 1 } as const
const recentOrdersQuery = { status: OrderCollection.All, limit: 1, direction: SortDirection.Descending } as const
const recentFillsQuery = { pageSize: 1, direction: SortDirection.Descending } as const

export const makeCachedBrokerRead = (
  fresh: BrokerReadShape,
  config: BrokerSnapshotCacheConfig,
): Effect.Effect<BrokerReadShape, BrokerReadError, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<CacheState>({ _tag: 'Invalidated', generation: 0 })
    const nextPollAt = yield* Ref.make(0)
    const pollTimeoutMs = Math.min(config.maxAgeMs - config.pollIntervalMs, config.maxAgeMs / 2)
    const invalidate = Ref.update(
      state,
      (current): CacheState => ({ _tag: 'Invalidated', generation: current.generation + 1 }),
    )
    yield* Effect.addFinalizer(() => invalidate)
    const poll = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      yield* Ref.set(nextPollAt, startedAt + config.pollIntervalMs)
      const generation = (yield* Ref.get(state)).generation
      const value = yield* Effect.all(
        {
          snapshot: readStableBrokerSnapshot(fresh, currentUtcInstant).pipe(
            Effect.mapError((cause) => (cause instanceof ReconciliationError ? snapshotError(cause) : cause)),
          ),
          configuration: fresh.accountConfiguration,
          openOrders: fresh.orders(openOrdersQuery),
          recentOrders: fresh.orders(recentOrdersQuery),
          recentFills: fresh.fillActivities(recentFillsQuery),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.flatMap((value) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((finishedAt) =>
              finishedAt - startedAt >= pollTimeoutMs
                ? Effect.fail(unavailable('Broker snapshot polling exceeded its deadline'))
                : Effect.succeed(value),
            ),
          ),
        ),
        Effect.timeoutOrElse({
          duration: pollTimeoutMs,
          orElse: () => Effect.fail(unavailable('Broker snapshot polling exceeded its deadline')),
        }),
        Effect.onError((cause) =>
          Ref.update(
            state,
            (current): CacheState =>
              current.generation === generation
                ? {
                    _tag: 'Failed',
                    generation,
                    error: new BrokerReadError({
                      operation: 'preflight',
                      kind: BrokerReadErrorKind.InvalidResponse,
                      retryable: false,
                      message: 'Broker snapshot polling failed',
                      cause: safeCause({ cause }),
                    }),
                  }
                : current,
          ),
        ),
        Effect.catch((error) =>
          Ref.update(
            state,
            (current): CacheState =>
              current.generation === generation ? { _tag: 'Failed', generation, error } : current,
          ).pipe(Effect.andThen(Effect.fail(error))),
        ),
      )
      const observedAtMs = Math.min(
        ...[
          value.snapshot.account.evidence.observedAt,
          value.snapshot.positions.evidence.observedAt,
          value.snapshot.history.orders.observedAt,
          value.configuration.evidence.observedAt,
          value.openOrders.evidence.observedAt,
          value.recentOrders.evidence.observedAt,
          value.recentFills.evidence.observedAt,
        ].map((at) => DateTime.toEpochMillis(DateTime.makeUnsafe(at))),
      )
      yield* Ref.update(
        state,
        (current): CacheState =>
          current.generation === generation
            ? { _tag: 'Ready', generation, value: { ...value, observedAtMs } }
            : current,
      )
    }).pipe(Effect.withSpan('broker.snapshot.poll'))

    yield* poll
    yield* Effect.gen(function* () {
      const next = yield* Ref.get(nextPollAt)
      const now = yield* Clock.currentTimeMillis
      yield* Effect.sleep(Math.max(0, next - now))
      yield* poll
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning('Broker snapshot polling failed').pipe(
          Effect.annotateLogs({
            'broker.operation': error.operation,
            'broker.failure_kind': error.kind,
            'broker.retryable': error.retryable,
          }),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )

    const cached = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const current = yield* Ref.get(state)
      if (current._tag === 'Failed') return yield* current.error
      if (current._tag === 'Invalidated')
        return yield* unavailable('Broker snapshot cache is waiting for a poll after invalidation')
      if (now < current.value.observedAtMs || now - current.value.observedAtMs >= config.maxAgeMs)
        return yield* unavailable('Broker snapshot cache is stale')
      return current.value
    })

    return {
      ...fresh,
      projection: { fresh, invalidate, snapshot: cached.pipe(Effect.map((value) => value.snapshot)) },
      account: cached.pipe(Effect.map((value) => value.snapshot.account)),
      positions: cached.pipe(Effect.map((value) => value.snapshot.positions)),
      accountConfiguration: cached.pipe(Effect.map((value) => value.configuration)),
      orders: (query) => {
        const { status, limit, direction, ...filters } = query ?? {}
        if (Object.keys(filters).length === 0 && limit === 1) {
          if (status === OrderCollection.Open && direction === undefined)
            return cached.pipe(Effect.map((value) => value.openOrders))
          if (status === OrderCollection.All && direction === SortDirection.Descending)
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
