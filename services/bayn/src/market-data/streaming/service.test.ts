import { expect, spyOn, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, Result } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'

import { streamingFixture } from '../../testing/streaming-market-fixture'
import { IntradayMarketData } from '../intraday/model'
import { persistIntradayRecordRows } from '../intraday/verification'
import { KafkaMarketFailure, KafkaMarketProjection } from './kafka'
import * as replay from './replay'
import { StreamingIntradayMarketDataLive } from './service'

test('readiness validates the owner without transferring a retained cut and preserves its failure', async () => {
  const unavailable = new KafkaMarketFailure({ operation: 'bootstrap', message: 'Source history is incomplete' })
  let checks = 0
  let fail = false
  const live = StreamingIntradayMarketDataLive.pipe(
    Layer.provide(
      Layer.effect(
        PgClient.PgClient,
        SqlClient.make({
          acquirer: Effect.die('Readiness must not query PostgreSQL'),
          compiler: PgClient.makeCompiler(undefined, false),
          spanAttributes: [],
        }).pipe(Effect.map((sql) => sql as PgClient.PgClient)),
      ),
    ),
    Layer.provide(
      Layer.succeed(KafkaMarketProjection, {
        startWakeups: () => Effect.void,
        check: Effect.suspend(() => {
          checks++
          return fail ? Effect.fail(unavailable) : Effect.void
        }),
        read: () => Effect.die('Readiness must not transfer the retained projection'),
        status: Effect.succeed({ epoch: 'source-epoch', ready: false, sequence: 0, bootstrapDeadlineAtMs: null }),
      }),
    ),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const market = yield* IntradayMarketData
        yield* market.check
        fail = true
        const result = yield* market.check.pipe(Effect.result)
        expect(checks).toBe(2)
        if (Result.isSuccess(result)) throw new Error('Incomplete source history must fail readiness')
        expect(result.failure).toMatchObject({ component: 'market-data', operation: 'check', cause: unavailable })
      }).pipe(Effect.provide(live), Effect.provide(Reactivity.layer)),
    ),
  )
})

test('reuses an exact captured cut without reconstructing it again and still rejects changed source rows', async () => {
  const fixture = streamingFixture()
  const reproduce = spyOn(replay, 'reproduceStreamingSnapshot')
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.make({
            acquirer: Effect.die('Captured market evidence must not query PostgreSQL'),
            compiler: PgClient.makeCompiler(undefined, false),
            spanAttributes: [],
          })
          const live = StreamingIntradayMarketDataLive.pipe(
            Layer.provide(Layer.succeed(PgClient.PgClient, sql as PgClient.PgClient)),
            Layer.provide(
              Layer.succeed(KafkaMarketProjection, {
                startWakeups: () => Effect.void,
                check: Effect.void,
                read: () => Effect.succeed(fixture.cut),
                status: Effect.succeed({
                  epoch: 'fixture-epoch',
                  ready: true,
                  bootstrapDeadlineAtMs: null,
                  sequence: fixture.cut.projection.sequence,
                }),
              }),
            ),
          )
          yield* Effect.gen(function* () {
            const market = yield* IntradayMarketData
            const unobserved = yield* market.verifyReference(fixture.snapshot).pipe(Effect.exit)
            expect(Exit.isFailure(unobserved)).toBe(true)
            const captured = yield* market.loadSnapshot(fixture.query)
            if (captured.manifest.schemaVersion !== 'bayn.streaming-market-snapshot.v1')
              throw new Error('Expected a live streaming snapshot')
            const rows = Result.getOrThrow(persistIntradayRecordRows(captured))
            const restored = Result.getOrThrow(replay.reproduceStreamingSnapshot(captured.manifest, rows))
            reproduce.mockClear()
            const reference = yield* market.verifyReference(restored)
            expect(reference.manifest).toEqual(captured.manifest)
            expect(reproduce).not.toHaveBeenCalled()

            const returnedPosition = reference.manifest.streaming.positions[0]
            if (returnedPosition === undefined) throw new Error('Missing fixture source position')
            Object.assign(returnedPosition, { offset: '999999999' })
            const repeated = yield* market.verifyReference(restored)
            expect(repeated.manifest).toEqual(captured.manifest)
            expect(reproduce).not.toHaveBeenCalled()

            const first = restored.quotes[0]
            if (first === undefined) throw new Error('Missing fixture quote')
            const changed = {
              ...restored,
              quotes: [{ ...first, askPrice: first.askPrice + 1 }, ...restored.quotes.slice(1)],
            }
            const rejected = yield* market.verifyReference(changed).pipe(Effect.result)
            expect(Result.isFailure(rejected)).toBe(true)
            expect(reproduce).toHaveBeenCalledTimes(1)
          }).pipe(Effect.provide(live))
        }),
      ).pipe(Effect.provide(Reactivity.layer)),
    )
  } finally {
    reproduce.mockRestore()
  }
})
