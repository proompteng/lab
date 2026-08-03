import { describe, expect, test } from 'bun:test'

import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import {
  closedCycleReceiptEmissionAllowed,
  paperReceiptFinalizationWindowOpen,
  restrictExpiredPaperActivation,
  retryClosedCycleReceipts,
} from './composition'
import type { AuthorityRestrictionStoreShape } from './db/execution-store'
import type { WriterFenceService } from './execution/writer-fence'
import { paperEpisodeReceiptFinalizationExpiresAt } from './observe-composition'

describe('Bayn PAPER receipt retry boundary', () => {
  test('does not bind a generation receipt before its PAPER entry cutoff', () => {
    const cutoffAt = '2026-08-03T12:00:00.000Z'

    expect(closedCycleReceiptEmissionAllowed(cutoffAt, '2026-08-03T11:59:59.999Z')).toBe(false)
    expect(closedCycleReceiptEmissionAllowed(cutoffAt, cutoffAt)).toBe(true)
  })

  test('keeps retrying through the close lease instead of a fixed attempt count', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = new Date(startAt + 1_000).toISOString()
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
          new Date(startAt + 17_000).toISOString(),
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

  test('keeps retrying until close settlement and reconciliation produce a receipt', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = new Date(startAt + 1_000).toISOString()
    const observedAt: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(startAt)
        const retry = yield* retryClosedCycleReceipts(
          (_cycleId, current) =>
            Effect.sync(() => {
              observedAt.push(current)
              return observedAt.length >= 8
            }),
          cutoffAt,
          new Date(startAt + 8_000).toISOString(),
          1_000,
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(8_000)
        yield* Fiber.join(retry)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observedAt).toHaveLength(8)
    expect(observedAt.at(-1)).toBe(new Date(startAt + 8_000).toISOString())
  })

  test('stops receipt retries at the bounded finalization lease when evidence never becomes eligible', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = new Date(startAt + 1_000).toISOString()
    const retryUntilAt = new Date(startAt + 4_000).toISOString()
    const observedAt: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(startAt)
        const retry = yield* retryClosedCycleReceipts(
          (_cycleId, current) =>
            Effect.sync(() => {
              observedAt.push(current)
              return false
            }),
          cutoffAt,
          retryUntilAt,
          1_000,
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10_000)
        yield* Fiber.join(retry)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observedAt).toHaveLength(4)
    expect(observedAt.at(-1)).toBe(retryUntilAt)
  })

  test('leaves a bounded post-close finalization window for late settlement', () => {
    expect(paperEpisodeReceiptFinalizationExpiresAt('2026-08-03T12:00:00.000Z')).toBe('2026-08-03T12:30:00.000Z')
  })

  test('keeps receipt finalization available after a restart during the close-to-receipt grace window', () => {
    expect(paperReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:15:00.001Z')).toBe(true)
    expect(paperReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:30:00.000Z')).toBe(false)
    expect(paperReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:14:59.999Z')).toBe(false)
  })
})

describe('Bayn PAPER startup recovery boundary', () => {
  test('restricts durable authority before an expired close recovery is rejected', async () => {
    const restrictions: Array<{ readonly reason: string; readonly updatedAt: string }> = []
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: (reason, updatedAt) =>
        Effect.sync(() => {
          restrictions.push({ reason, updatedAt })
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-08-03T12:00:00.000Z'))
        yield* restrictExpiredPaperActivation(authorityRestrictionStore, writerFence)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(restrictions).toEqual([
      {
        reason: 'PAPER activation lease restricted effective authority: immutable activation request expired',
        updatedAt: '2026-08-03T12:00:00.000Z',
      },
    ])
  })
})
