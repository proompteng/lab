import { describe, expect, test } from 'bun:test'
import { NodeRedis } from '@effect/platform-node'
import type { PgClient } from '@effect/sql-pg'
import { Effect, Fiber, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import { makeValkeyCache, ValkeyCache } from '../valkey-cache'
import { makeBrokerObservationStore } from './broker-observations'

describe('Broker observation cache publication', () => {
  test('the immutable payload pair shares one replication barrier within the original deadline', async () => {
    const waiting = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const acknowledgements = [Promise.withResolvers<number>(), Promise.withResolvers<number>()]
    const writes: string[] = []
    let waits = 0
    let publications = 0
    let open = true
    const client = {
      get isOpen() {
        return open
      },
      connect: async () => {
        open = true
      },
      destroy: () => {
        open = false
      },
      withAbortSignal: () => ({
        set: async (key: string) => {
          writes.push(key)
          return 'OK'
        },
        wait: () => {
          const index = waits++
          waiting[index]?.resolve()
          return acknowledgements[index]?.promise ?? new Promise<never>(() => {})
        },
      }),
    } as unknown as NodeRedis.NodeRedis['Service']['client']
    const sql = ((strings: TemplateStringsArray) =>
      Effect.sync(() => {
        expect(strings.join('')).toContain('WITH published AS')
        publications++
        return [{ account_id: 'publication-test' }]
      })) as unknown as PgClient.PgClient

    await Effect.gen(function* () {
      const cache = yield* ValkeyCache
      const startedAt = '2026-01-05T15:00:00.000Z'
      yield* TestClock.setTime(Date.parse(startedAt))
      const store = makeBrokerObservationStore(sql, 'publication-test', 'a'.repeat(40), 60_000, cache)
      const published = yield* store
        .publish({ generation: 1, startedAt }, observedBrokerSnapshotFixture('publication-test', startedAt), 0)
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => waiting[0]!.promise)
      expect(publications).toBe(0)
      yield* TestClock.adjust('300 millis')
      acknowledgements[0]!.resolve(0)
      yield* Effect.promise(() => waiting[1]!.promise)
      expect(publications).toBe(0)
      yield* TestClock.adjust('300 millis')
      acknowledgements[1]!.resolve(1)
      yield* TestClock.adjust('400 millis')
      const result = yield* Fiber.join(published)
      expect(result).toEqual(Result.succeed(true))
      expect(publications).toBe(1)
      expect(writes).toHaveLength(2)
      expect(writes.some((key) => key.startsWith('bayn:broker:snapshot:'))).toBe(true)
      expect(writes.some((key) => key.startsWith('bayn:broker:state:'))).toBe(true)
      expect(waits).toBe(2)
    }).pipe(
      Effect.provide(
        Layer.effect(ValkeyCache, makeValkeyCache).pipe(
          Layer.provide(Layer.succeed(NodeRedis.NodeRedis, { client, use: () => Effect.die('unused') })),
        ),
      ),
      Effect.provide(TestClock.layer()),
      Effect.runPromise,
    )
  })
})
