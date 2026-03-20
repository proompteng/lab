import { afterEach, describe, expect, test } from 'bun:test'

import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Stream from 'effect/Stream'

import { createLogger } from './logger'
import { makeTargetHealthLayer, TargetHealthService } from './target-health'
import { makeTestConfig } from './test-fixtures'
import { WorkflowService } from './workflow'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.GH_TOKEN
  delete process.env.SYMPHONY_TRANSIENT_HEALTH_GRACE_MS
})

describe('target health resilience', () => {
  test('treats short-lived HTTP health failures as transient after a recent healthy check', async () => {
    const config = makeTestConfig({
      health: {
        preDispatch: [
          {
            name: 'symphony-livez',
            type: 'http',
            namespace: null,
            application: null,
            url: 'https://symphony.example.test/livez',
            expectedStatus: 200,
            expectedSync: null,
            expectedHealth: null,
            resourceKind: null,
            resourceName: null,
            path: null,
          },
        ],
      },
    })

    let livezRequests = 0
    process.env.GH_TOKEN = 'test-token'
    process.env.SYMPHONY_TRANSIENT_HEALTH_GRACE_MS = '60000'

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('/pulls?state=open')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === 'https://symphony.example.test/livez') {
        livezRequests += 1
        if (livezRequests === 1) {
          return new Response('', { status: 200 })
        }
        throw new Error('temporary connection reset')
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    const runtime = ManagedRuntime.make(
      makeTargetHealthLayer(createLogger({ test: 'target-health' })).pipe(
        Layer.provide(
          Layer.succeed(WorkflowService, {
            current: Effect.succeed({
              definition: { config: {}, promptTemplate: '' },
              config,
            }),
            config: Effect.succeed(config),
            reload: Effect.succeed({
              definition: { config: {}, promptTemplate: '' },
              config,
            }),
            changes: Stream.empty,
          }),
        ),
      ),
    )

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const targetHealth = yield* TargetHealthService
          const healthy = yield* targetHealth.evaluatePreDispatch
          expect(healthy.readyForDispatch).toBe(true)
          expect(healthy.lastError).toBeNull()

          const transient = yield* targetHealth.evaluatePreDispatch
          expect(transient.readyForDispatch).toBe(true)
          expect(transient.lastError).toBeNull()
          expect(transient.checks[0]?.ok).toBe(false)
          expect(transient.checks[0]?.message).toContain('transient observation:')
        }),
      )
    } finally {
      await runtime.dispose()
    }
  })
})
