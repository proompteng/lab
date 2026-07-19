import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit } from 'effect'

import { makeDependencyRegistry } from './dependencies'
import { makeLifecycle } from './lifecycle'
import { startHttpServer } from './server'

describe('Bayn HTTP server lifecycle', () => {
  test('serves health endpoints and marks shutdown before releasing the socket', async () => {
    const lifecycle = await Effect.runPromise(makeLifecycle)
    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startHttpServer({ hostname: '127.0.0.1', port: 0 }, lifecycle, makeDependencyRegistry())

          return yield* Effect.tryPromise(() => fetch(`http://${server.hostname}:${server.port}/readyz`))
        }),
      ),
    )

    expect(response.status).toBe(200)
    expect(await Effect.runPromise(lifecycle.phase)).toBe('stopping')
  })

  test('returns a typed startup failure when the socket cannot be bound', async () => {
    const occupied = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('occupied'),
    })
    const lifecycle = await Effect.runPromise(makeLifecycle)

    try {
      if (occupied.port === undefined) {
        throw new Error('Bun did not expose the occupied test port')
      }
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          startHttpServer({ hostname: '127.0.0.1', port: occupied.port }, lifecycle, makeDependencyRegistry()),
        ),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(failure._tag).toBe('Some')
        if (failure._tag === 'Some') {
          expect(failure.value._tag).toBe('ServerStartError')
        }
      }
      expect(await Effect.runPromise(lifecycle.phase)).toBe('starting')
    } finally {
      await occupied.stop(true)
    }
  })
})
