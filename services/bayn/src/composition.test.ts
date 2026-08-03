import { describe, expect, test } from 'bun:test'

import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { retryClosedCycleReceipts } from './composition'

describe('Bayn PAPER receipt retry boundary', () => {
  test('keeps retrying through the close lease instead of a fixed attempt count', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = new Date(startAt + 1_000).toISOString()
    const closeExpiresAt = new Date(startAt + 18_000).toISOString()
    const observedAt: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(startAt)
        const retry = yield* retryClosedCycleReceipts(
          (cycleId, current) =>
            Effect.sync(() => {
              expect(cycleId).toBeUndefined()
              observedAt.push(current)
              return observedAt.length >= 17
            }),
          cutoffAt,
          closeExpiresAt,
          1_000,
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(17_000)
        yield* Fiber.join(retry)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observedAt).toHaveLength(17)
    expect(observedAt.at(-1)).toBe(new Date(startAt + 17_000).toISOString())
  })
})
