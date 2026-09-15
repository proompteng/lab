import { describe, expect, test } from 'bun:test'

import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer } from 'effect'

import { persistedMarketDataContract } from '../testing/persisted-snapshot-fixture'
import { config } from '../testing/runtime-fixtures'
import { MarketData } from './model'
import { MarketDataLive } from './program'
import { makeMarketDataQueries } from './queries'

const makeSqlRecorder = (queryIds: string[]): ClickhouseClient.ClickhouseClient => {
  const statement = (): Effect.Effect<readonly unknown[]> => Effect.succeed([])
  return Object.assign(statement, {
    param: (_type: string, value: unknown) => value,
    withQueryId:
      (queryId: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.sync(() => queryIds.push(queryId)).pipe(Effect.andThen(effect)),
  }) as unknown as ClickhouseClient.ClickhouseClient
}

describe('market-data query execution identity', () => {
  test('keeps one logical operation while assigning every concurrent replica attempt a unique query id', async () => {
    const queryIds: string[] = []
    const left = makeMarketDataQueries(makeSqlRecorder(queryIds), config, persistedMarketDataContract)
    const right = makeMarketDataQueries(makeSqlRecorder(queryIds), config, persistedMarketDataContract)

    await Effect.runPromise(
      Effect.all(
        [
          left.loadCyclePublicationManifests,
          left.loadCyclePublicationManifests,
          right.loadCyclePublicationManifests,
          right.loadCyclePublicationManifests,
        ],
        { concurrency: 'unbounded' },
      ),
    )

    expect(queryIds).toHaveLength(4)
    expect(new Set(queryIds).size).toBe(4)
    expect(queryIds.every((queryId) => /^bayn-cycle-publication-candidates-[0-9a-f-]{36}$/.test(queryId))).toBe(true)
  })

  test('interrupts a stalled ClickHouse read at the aggregate operation deadline', async () => {
    let interrupted = false
    const statement = (): Effect.Effect<readonly unknown[]> =>
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))))
    const client = Object.assign(statement, {
      param: (_type: string, value: unknown) => value,
      withQueryId:
        (_queryId: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect,
    }) as unknown as ClickhouseClient.ClickhouseClient
    const layer = MarketDataLive({ ...config, operationTimeoutMs: 5 }, persistedMarketDataContract).pipe(
      Layer.provide(Layer.succeed(ClickhouseClient.ClickhouseClient, client)),
    )

    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const marketData = yield* MarketData
          return yield* marketData.inspectCyclePublications
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(interrupted).toBe(true)
    expect(failure).toMatchObject({
      _tag: 'OperationalError',
      component: 'market-data',
      operation: 'inspect-publication',
      retryable: true,
      cause: { _tag: 'TimeoutError' },
    })
  })
})
