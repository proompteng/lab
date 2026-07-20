import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer } from 'effect'

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('ClickHouse test server did not bind a TCP port'))
        return
      }
      resolve(address.port)
    })
  })

test('Effect ClickHouse drains its connection check before exposing the client', async () => {
  let responseFinished = false
  let requests = 0
  const server = createServer((_, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/plain; charset=UTF-8', 'x-clickhouse-summary': '{}' })
    response.flushHeaders()
    response.write('1\n')
    setTimeout(() => {
      responseFinished = true
      response.end()
    }, 250)
  })
  const port = await listen(server)

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
    server.close()
    server.closeAllConnections()
  }
})
