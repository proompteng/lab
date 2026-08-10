import { expect, test } from 'bun:test'

import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, Ref, Stream } from 'effect'

test('Effect ClickHouse drains its connection check before exposing the client', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const responseFinished = yield* Ref.make(false)
        const requests = yield* Ref.make(0)
        const runSync = Effect.runSyncWith(yield* Effect.context<never>())
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: '127.0.0.1',
              port: 0,
              fetch: () => {
                runSync(Ref.update(requests, (count) => count + 1))
                const body = Stream.make('1\n').pipe(
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.sleep(250).pipe(Effect.andThen(Ref.set(responseFinished, true)), Effect.as('')),
                    ),
                  ),
                  Stream.encodeText,
                  Stream.toReadableStream,
                )
                return new Response(body, {
                  headers: {
                    'content-type': 'text/plain; charset=UTF-8',
                    'x-clickhouse-summary': '{}',
                  },
                })
              },
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
