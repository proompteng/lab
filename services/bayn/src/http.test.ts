import { describe, expect, test } from 'bun:test'
import { Effect, Ref } from 'effect'

import { makeDependencyRegistry } from './dependencies'
import { DependencyUnavailableError } from './errors'
import { handleRequest } from './http'
import { makeLifecycle } from './lifecycle'

type JsonObject = Record<string, unknown>

const request = (path: string, method = 'GET') => new Request(`http://bayn.test${path}`, { method })

const json = async (response: Response): Promise<JsonObject> => (await response.json()) as JsonObject

describe('Bayn health endpoints', () => {
  test('/livez reports a live process without checking dependencies', async () => {
    const checks = await Effect.runPromise(Ref.make(0))
    const lifecycle = await Effect.runPromise(makeLifecycle)
    const dependencies = makeDependencyRegistry([
      {
        name: 'unused',
        check: Ref.update(checks, (count) => count + 1),
      },
    ])

    const response = await Effect.runPromise(handleRequest(request('/livez'), lifecycle, dependencies))

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ service: 'bayn', status: 'live' })
    expect(await Effect.runPromise(Ref.get(checks))).toBe(0)
  })

  test('/readyz stays unavailable while startup is incomplete', async () => {
    const lifecycle = await Effect.runPromise(makeLifecycle)
    const response = await Effect.runPromise(handleRequest(request('/readyz'), lifecycle, makeDependencyRegistry()))

    expect(response.status).toBe(503)
    expect(await json(response)).toEqual({
      service: 'bayn',
      status: 'not-ready',
      phase: 'starting',
      dependencies: [],
    })
  })

  test('/readyz reports ready only after startup and successful dependency checks', async () => {
    const lifecycle = await Effect.runPromise(makeLifecycle)
    await Effect.runPromise(lifecycle.markReady)
    const dependencies = makeDependencyRegistry([{ name: 'signal', check: Effect.void }])

    const response = await Effect.runPromise(handleRequest(request('/readyz'), lifecycle, dependencies))

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      service: 'bayn',
      status: 'ready',
      phase: 'ready',
      dependencies: [{ name: 'signal', status: 'ready' }],
    })
  })

  test('/readyz fails closed on typed dependency failures and timeouts', async () => {
    const lifecycle = await Effect.runPromise(makeLifecycle)
    await Effect.runPromise(lifecycle.markReady)
    const dependencies = makeDependencyRegistry([
      {
        name: 'signal',
        check: Effect.fail(
          new DependencyUnavailableError({
            dependency: 'signal',
            message: 'unavailable',
          }),
        ),
      },
      {
        name: 'ledger',
        check: Effect.never,
        timeoutMs: 5,
      },
    ])

    const response = await Effect.runPromise(handleRequest(request('/readyz'), lifecycle, dependencies))

    expect(response.status).toBe(503)
    expect(await json(response)).toEqual({
      service: 'bayn',
      status: 'not-ready',
      phase: 'ready',
      dependencies: [
        { name: 'signal', status: 'not-ready' },
        { name: 'ledger', status: 'not-ready' },
      ],
    })
  })

  test('/readyz reports shutdown as not ready', async () => {
    const lifecycle = await Effect.runPromise(makeLifecycle)
    await Effect.runPromise(lifecycle.markReady)
    await Effect.runPromise(lifecycle.markStopping)

    const response = await Effect.runPromise(handleRequest(request('/readyz'), lifecycle, makeDependencyRegistry()))

    expect(response.status).toBe(503)
    expect((await json(response)).phase).toBe('stopping')
  })

  test('does not expose an order API', async () => {
    const lifecycle = await Effect.runPromise(makeLifecycle)
    const dependencies = makeDependencyRegistry()

    const getResponse = await Effect.runPromise(handleRequest(request('/orders'), lifecycle, dependencies))
    const postResponse = await Effect.runPromise(handleRequest(request('/orders', 'POST'), lifecycle, dependencies))

    expect(getResponse.status).toBe(404)
    expect(postResponse.status).toBe(404)
  })
})
