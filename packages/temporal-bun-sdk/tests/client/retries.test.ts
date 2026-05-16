import { describe, expect, test } from 'bun:test'
import { ConnectError, Code } from '@connectrpc/connect'
import { Effect } from 'effect'

import { withTemporalRetry, defaultRetryPolicy } from '../../src/client/retries'

const run = <A>(effect: Effect.Effect<A, unknown, never>) => Effect.runPromise(effect)

describe('Temporal RPC retries', () => {
  test('default policy survives short Temporal frontend disruption windows', () => {
    expect(defaultRetryPolicy.maxAttempts).toBeGreaterThanOrEqual(16)
    expect(defaultRetryPolicy.initialDelayMs).toBeLessThanOrEqual(250)
    expect(defaultRetryPolicy.maxDelayMs).toBeGreaterThanOrEqual(10_000)
    expect(defaultRetryPolicy.retryableStatusCodes).toEqual(
      expect.arrayContaining([Code.Unavailable, Code.ResourceExhausted, Code.DeadlineExceeded, Code.Internal]),
    )
  })

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

  test('retries Temporal server unknown errors when the message says to retry', async () => {
    let attempts = 0
    const effect = Effect.tryPromise({
      try: async () => {
        attempts += 1
        if (attempts < 3) {
          throw new ConnectError('something went wrong, please retry (2f921658)', Code.Unknown)
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

  test('does not retry opaque unknown errors without a retry hint', async () => {
    let attempts = 0
    const effect = Effect.tryPromise({
      try: async () => {
        attempts += 1
        throw new ConnectError('unknown fatal failure', Code.Unknown)
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
    ).rejects.toThrow('unknown fatal failure')
    expect(attempts).toBe(1)
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

  test('does not retry TLS handshake errors', async () => {
    let attempts = 0
    const effect = Effect.tryPromise({
      try: async () => {
        attempts += 1
        const error = new Error('Temporal TLS handshake failed')
        error.name = 'TemporalTlsHandshakeError'
        throw error
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
    ).rejects.toThrow('Temporal TLS handshake failed')
    expect(attempts).toBe(1)
  })
})
