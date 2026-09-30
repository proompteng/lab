import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { Undici } from '@effect/platform-node'
import { Cause, Effect, Exit, Fiber, Redacted } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import { RuneError } from './client'
import { JevFailure } from '../jev/contract'
import { RuneHttpClientLive } from './http'

await test('sends a direct HTTP request without credentials or a proxy', async () => {
  const requests: { path: string | undefined; authorization: string | undefined }[] = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization })
    response.setHeader('content-type', 'application/json')
    response.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Server did not bind a TCP port')
    const response = await Effect.runPromise(
      HttpClient.HttpClient.pipe(
        Effect.flatMap((client) => client.get(`http://127.0.0.1:${address.port}/v1/decisions`)),
        Effect.flatMap((response) => response.json),
        Effect.provide(RuneHttpClientLive()),
      ),
    )
    assert.deepEqual(response, { ok: true })
    assert.deepEqual(requests, [{ path: '/v1/decisions', authorization: undefined }])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

for (const end of ['complete', 'interrupted'] as const)
  await test(`destroys the scoped Rune dispatcher once when ${end}`, async () => {
    let releases = 0
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* HttpClient.HttpClient
        assert.equal(releases, 0)
        if (end === 'interrupted') return yield* Effect.interrupt
      }).pipe(
        Effect.provide(
          RuneHttpClientLive({
            create: () => new Undici.Agent(),
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

await test('retains dispatcher acquisition failure in the typed redacted error channel', async () => {
  const cause = new Error('construction failed')
  const exit = await Effect.runPromiseExit(
    HttpClient.HttpClient.pipe(
      Effect.provide(
        RuneHttpClientLive({
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
    assert(failure instanceof RuneError)
    assert.equal(failure.failure, JevFailure.Transport)
    assert(failure.cause !== undefined)
    assert.equal(Redacted.value(failure.cause), cause)
    assert(!JSON.stringify(failure).includes(cause.message))
  }
})

await test('interrupting an in-flight request closes the real HTTP connection', async () => {
  const started = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const server = createServer((_request, response) => {
    response.on('close', () => closed.resolve())
    started.resolve()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Server did not bind a TCP port')
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          const fiber = yield* http
            .post(`http://127.0.0.1:${address.port}/v1/decisions`)
            .pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Effect.promise(() => started.promise)
          yield* Fiber.interrupt(fiber)
          yield* Effect.promise(() => closed.promise)
        }),
      ).pipe(Effect.provide(RuneHttpClientLive()), Effect.timeout('3 seconds')),
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
