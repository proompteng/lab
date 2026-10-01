import { expect, test } from 'bun:test'

import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, Ref } from 'effect'

test('Effect ClickHouse verifies connectivity before exposing the client', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const responseFinished = yield* Ref.make(false)
        const requests = yield* Ref.make(0)
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: '127.0.0.1',
              port: 0,
              fetch: () =>
                runPromise(
                  Ref.update(requests, (count) => count + 1).pipe(
                    Effect.andThen(Effect.sleep(250)),
                    Effect.andThen(Ref.set(responseFinished, true)),
                    Effect.as(new Response('Ok.')),
                  ),
                ),
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const clickhouseServices = yield* Layer.build(
          ClickhouseClient.layer({
            url: server.url.href,
            username: 'default',
            password: '',
            database: 'signal',
            application: 'bayn-patch-test',
            request_timeout: 1_000,
          }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp)),
        )
        yield* Effect.gen(function* () {
          yield* ClickhouseClient.ClickhouseClient
          expect(yield* Ref.get(responseFinished)).toBe(true)
          expect(yield* Ref.get(requests)).toBe(1)
        }).pipe(Effect.provide(clickhouseServices))
      }),
    ),
  ))
