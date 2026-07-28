import { describe, expect, test } from 'bun:test'

import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, Redacted, Schedule } from 'effect'
import {
  Runner,
  RunnerAddress,
  RunnerStorage,
  ShardId,
  ShardingConfig,
  SqlRunnerStorage,
} from 'effect/unstable/cluster'
import { SqlClient, type SqlConnection, SqlError } from 'effect/unstable/sql'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const describePostgres = postgresUrl === undefined ? describe.skip : describe

interface PartitionState {
  current: boolean
  activeQueries: number
  interruptedQueries: number
  maxActiveQueries: number
  reservedConnections: number
}

const makePartitionState = (): PartitionState => ({
  current: false,
  activeQueries: 0,
  interruptedQueries: 0,
  maxActiveQueries: 0,
  reservedConnections: 0,
})

const waitUntil = (predicate: () => boolean) =>
  Effect.suspend(function poll(): Effect.Effect<void> {
    return predicate() ? Effect.void : Effect.sleep(20).pipe(Effect.andThen(poll))
  }).pipe(
    Effect.timeoutOrElse({
      duration: 10_000,
      orElse: () => Effect.die('timed out waiting for reserved connection rebuild'),
    }),
  )

const blackholeReservedConnection = (state: PartitionState, url: string) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const wrapConnection = (connection: SqlConnection.Connection): SqlConnection.Connection => {
        const execute = <A, E extends SqlError.SqlError, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.suspend(function waitForConnection(): Effect.Effect<A, E, R> {
            if (!state.current) return effect
            return Effect.never
          }).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                state.activeQueries -= 1
                if (Exit.hasInterrupts(exit)) state.interruptedQueries += 1
              }),
            ),
          )

        const tracked = <A, E extends SqlError.SqlError, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.sync(() => {
            state.activeQueries += 1
            state.maxActiveQueries = Math.max(state.maxActiveQueries, state.activeQueries)
          }).pipe(Effect.andThen(execute(effect)))

        return {
          ...connection,
          execute: (...arguments_) => tracked(connection.execute(...arguments_)),
          executeRaw: (...arguments_) => tracked(connection.executeRaw(...arguments_)),
          executeStream: connection.executeStream,
          executeUnprepared: (...arguments_) => tracked(connection.executeUnprepared(...arguments_)),
          executeValues: (...arguments_) => tracked(connection.executeValues(...arguments_)),
          executeValuesUnprepared: (...arguments_) => tracked(connection.executeValuesUnprepared(...arguments_)),
        }
      }

      let client: SqlClient.SqlClient
      client = new Proxy(sql, {
        get(target, property, receiver) {
          if (property === 'reserve') {
            return Effect.map(target.reserve, (connection) => {
              state.reservedConnections += 1
              return wrapConnection(connection)
            })
          }
          if (property === 'withoutTransforms') return () => client
          return Reflect.get(target, property, receiver)
        },
      })
      return client
    }),
  ).pipe(
    Layer.provide(
      PgClient.layer({
        url: Redacted.make(url),
        maxConnections: 4,
      }),
    ),
  )

describePostgres('Effect beta.102 SQL runner compatibility', () => {
  test('bounds lock refreshes and rebuilds an unresponsive reserved PostgreSQL connection', async () => {
    const state = makePartitionState()
    const prefix = `bayn_effect_beta102_${process.pid}`
    const storageLayer = SqlRunnerStorage.layerWith({ prefix }).pipe(
      Layer.provideMerge(blackholeReservedConnection(state, postgresUrl!)),
      Layer.provide(
        ShardingConfig.layer({
          shardLockDisableAdvisory: true,
          shardLockExpiration: 1_000,
          shardLockRefreshInterval: 100,
        }),
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* RunnerStorage.RunnerStorage
        const address = RunnerAddress.make('127.0.0.1', 49_061)
        const runner = Runner.make({ address, groups: ['default'], weight: 1 })
        const shards = [ShardId.make('default', 1)]

        yield* storage.register(runner, true)
        expect(yield* storage.acquire(address, shards)).toEqual(shards)
        const initialReservations = state.reservedConnections

        state.current = true
        const startedAt = Date.now()
        const failedRefresh = yield* storage.refresh(address, shards).pipe(Effect.exit)
        const elapsedMs = Date.now() - startedAt

        expect(Exit.isFailure(failedRefresh)).toBe(true)
        expect(elapsedMs).toBeGreaterThanOrEqual(80)
        expect(elapsedMs).toBeLessThan(1_000)
        yield* waitUntil(() => state.reservedConnections > initialReservations)
        expect(state.interruptedQueries).toBeGreaterThanOrEqual(1)
        expect(state.maxActiveQueries).toBeLessThanOrEqual(1)

        state.current = false
        expect(
          yield* storage.refresh(address, shards).pipe(Effect.retry({ times: 10, schedule: Schedule.spaced(20) })),
        ).toEqual(shards)
        yield* storage.releaseAll(address)
        yield* storage.unregister(address)
      }).pipe(Effect.provide(storageLayer)),
    )
  }, 60_000)
})
