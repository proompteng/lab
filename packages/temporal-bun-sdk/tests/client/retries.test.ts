import { describe, expect, test } from 'bun:test'
import { ConnectError, Code } from '@connectrpc/connect'
import { Effect } from 'effect'

import { withTemporalRetry, defaultRetryPolicy } from '../../src/client/retries'

const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect)

describe('Temporal RPC retries', () => {
  test('retries retryable ConnectError codes until success', async () => {
    let attempts = 0
    const effect = Effect.tryPromise({
      try: async () => {
        attempts += 1
        if (attempts < 3) {
          throw new ConnectError('flaky', Code.Unavailable)
        }
        return 'ok'
      },
      catch: (error) => error,
    })

    const result = await run(
      withTemporalRetry(effect, {
        ...defaultRetryPolicy,
        maxAttempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 2,
      }),
    )

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  test('stops immediately on non-retryable errors', async () => {
    let attempts = 0
    const effect = Effect.tryPromise({
      try: async () => {
        attempts += 1
        throw new ConnectError('fatal', Code.InvalidArgument)
      },
      catch: (error) => error,
    })

    await expect(
      run(
        withTemporalRetry(effect, {
          ...defaultRetryPolicy,
          maxAttempts: 5,
        }),
      ),
    ).rejects.toThrow('fatal')
    expect(attempts).toBe(1)
  })
})
