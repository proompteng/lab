import { describe, expect, test } from 'bun:test'

import { Effect, Ref } from 'effect'

import { makeHttpServer, type RuntimeState } from './app'

describe('Bayn HTTP probes', () => {
  test('serves process liveness at /livez', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null })
          const server = yield* makeHttpServer({ host: '127.0.0.1', port: 0 }, state)
          const address = server.address()
          if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port')

          const result = yield* Effect.promise(async () => {
            const response = await fetch(`http://127.0.0.1:${address.port}/livez`)
            return { status: response.status, body: await response.json() }
          })
          expect(result).toEqual({ status: 200, body: { service: 'bayn', live: true } })
        }),
      ),
    )
  })
})
