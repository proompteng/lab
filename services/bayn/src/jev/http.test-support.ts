import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { Undici } from '@effect/platform-node'
import { Cause, Effect, Exit, Redacted } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import { JevClient, JevClientLive, JevError } from './client'
import { JevFailure } from './contract'
import { JevHttpClientLive } from './http'
import { requestFixture } from './test-support'

await test('routes the fixed TypeSafe endpoint through CONNECT without disclosing its API key to the proxy', async () => {
  const requests: { target: string | undefined; authorization: string | undefined }[] = []
  const proxy = createServer()
  proxy.on('connect', (request, socket) => {
    requests.push({ target: request.url, authorization: request.headers.authorization })
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = proxy.address()
    if (address === null || typeof address === 'string') throw new Error('Proxy did not bind a TCP port')
    const result = await Effect.runPromise(
      JevClient.pipe(
        Effect.flatMap((client) => client.evaluate(requestFixture)),
        Effect.provide(JevClientLive(Redacted.make('local-test-key'), 1000)),
        Effect.provide(JevHttpClientLive(`http://127.0.0.1:${address.port}`)),
        Effect.result,
      ),
    )
    assert.equal(result._tag, 'Failure')
    if (result._tag === 'Failure') assert.equal(result.failure.failure, JevFailure.Transport)
    assert.deepEqual(requests, [{ target: 'api.typesafe.ai:443', authorization: undefined }])
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())))
  }
})

for (const end of ['complete', 'interrupted'] as const)
  await test(`destroys the scoped Jev dispatcher once when ${end}`, async () => {
    let releases = 0
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* HttpClient.HttpClient
        assert.equal(releases, 0)
        if (end === 'interrupted') return yield* Effect.interrupt
      }).pipe(
        Effect.provide(
          JevHttpClientLive('http://127.0.0.1:3128', {
            create: (uri) => new Undici.ProxyAgent({ uri }),
            destroy: async (dispatcher) => {
              releases += 1
              await dispatcher.destroy()
            },
          }),
        ),
      ),
    )
    assert.equal(Exit.isSuccess(exit), end === 'complete')
    assert.equal(releases, 1)
  })

await test('rejects an unsafe proxy before acquiring a dispatcher', async () => {
  let acquired = 0
  const exit = await Effect.runPromiseExit(
    HttpClient.HttpClient.pipe(
      Effect.provide(
        JevHttpClientLive('http://user:secret@proxy.test:3128', {
          create: (uri) => {
            acquired += 1
            return new Undici.ProxyAgent({ uri })
          },
          destroy: (dispatcher) => dispatcher.destroy(),
        }),
      ),
    ),
  )
  assert.equal(acquired, 0)
  assert(Exit.isFailure(exit))
  if (Exit.isFailure(exit)) {
    const cause = Cause.squash(exit.cause)
    assert(cause instanceof JevError)
    assert.equal(cause.failure, JevFailure.Request)
    assert(!JSON.stringify(cause).includes('user:secret'))
  }
})

await test('retains dispatcher acquisition failure in the typed redacted error channel', async () => {
  const cause = new Error('construction failed')
  const exit = await Effect.runPromiseExit(
    HttpClient.HttpClient.pipe(
      Effect.provide(
        JevHttpClientLive('http://127.0.0.1:3128', {
          create: () => {
            throw cause
          },
          destroy: () => Promise.reject(new Error('Unacquired dispatcher must not be released')),
        }),
      ),
    ),
  )
  assert(Exit.isFailure(exit))
  if (Exit.isFailure(exit)) {
    const failure = Cause.squash(exit.cause)
    assert(failure instanceof JevError)
    assert.equal(failure.failure, JevFailure.Transport)
    assert(failure.cause !== undefined)
    assert.equal(Redacted.value(failure.cause), cause)
  }
})
