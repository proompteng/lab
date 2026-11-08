import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Stream } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'

import { canonicalJsonV1Result } from '../hash'
import { makeNativeArrivalChunk, nativeArrival } from '../market-data/streaming/native-arrival'
import {
  nativeArrivalEpochFixture as epoch,
  nativeArrivalObservationFixture as observation,
} from '../market-data/streaming/native-arrival.test-support'
import { streamNativeArrivalChunkPage } from './native-arrival-postgres'

test('native pages decode only consumed chunks and reject corruption when reached', async () => {
  const first = Result.getOrThrow(makeNativeArrivalChunk(epoch, 0, null, [nativeArrival(epoch, observation(1))]))
  const second = Result.getOrThrow(
    makeNativeArrivalChunk(epoch, 1, first.contentHash, [nativeArrival(epoch, observation(2))]),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* SqlClient.make({
          acquirer: Effect.die('Native page tests never connect to PostgreSQL'),
          compiler: PgClient.makeCompiler(undefined, false),
          spanAttributes: [],
        })
        const sql = new Proxy(client, {
          apply() {
            return Effect.succeed(
              [first, second].map((chunk, index) => ({
                content_hash: chunk.contentHash,
                header: Result.getOrThrow(canonicalJsonV1Result(chunk.header)),
                compressed: index === 0 ? chunk.compressed : Uint8Array.of(0),
              })),
            )
          },
        }) as PgClient.PgClient
        const page = streamNativeArrivalChunkPage(sql, epoch, -1)
        const consumed = yield* page.pipe(Stream.take(1), Stream.runCollect)
        expect(consumed).toEqual([{ ...first, records: [nativeArrival(epoch, observation(1))] }])
        expect(Result.isFailure(yield* page.pipe(Stream.runCollect, Effect.result))).toBe(true)
        const wrongEpoch = { ...epoch, bootstrap: { ...epoch.bootstrap, epoch: 'different-consumer' } }
        expect(
          Result.isFailure(
            yield* streamNativeArrivalChunkPage(sql, wrongEpoch, -1).pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.result,
            ),
          ),
        ).toBe(true)
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  )
})
