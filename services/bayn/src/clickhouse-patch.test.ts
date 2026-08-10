import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Fiber, Layer } from 'effect'

const listen = (server: ReturnType<typeof createServer>): Effect.Effect<number> =>
  Effect.callback<number>((resume) => {
    const onError = (cause: Error) => resume(Effect.die(cause))
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        resume(Effect.die(new Error('ClickHouse test server did not bind a TCP port')))
        return
      }
      resume(Effect.succeed(address.port))
    })
    return Effect.sync(() => server.off('error', onError))
  })

test('Effect ClickHouse drains its connection check before exposing the client', async () => {
  let responseFinished = false
  let requests = 0
  const responseFibers: Array<Fiber.Fiber<void>> = []
  const server = createServer((_, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/plain; charset=UTF-8', 'x-clickhouse-summary': '{}' })
    response.flushHeaders()
    response.write('1\n')
    responseFibers.push(
      Effect.sleep(250).pipe(
        Effect.andThen(
          Effect.sync(() => {
            responseFinished = true
            response.end()
          }),
        ),
        Effect.runFork,
      ),
    )
  })
  const port = await Effect.runPromise(listen(server))

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* ClickhouseClient.ClickhouseClient
          expect(responseFinished).toBe(true)
        }).pipe(
          Effect.provide(
            ClickhouseClient.layer({
              url: `http://127.0.0.1:${port}`,
              username: 'default',
              password: '',
              database: 'signal',
              application: 'bayn-patch-test',
              request_timeout: 1_000,
            }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp)),
          ),
        ),
      ),
    )
    expect(requests).toBe(1)
  } finally {
    await Effect.runPromise(Effect.forEach(responseFibers, Fiber.interrupt, { discard: true }))
    server.close()
    server.closeAllConnections()
  }
})
