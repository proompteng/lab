import { describe, expect, test } from 'bun:test'

import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import type { AuthorityGenerationStoreShape } from './db/execution-store'
import type { BlockedCycleIntentStoreShape } from './execution/intents'
import type { WriterFenceService } from './execution/writer-fence'
import { recoverTerminalGenerationToObserve } from './blocked-generation-recovery'
import { utcInstantFromEpochMillis } from './time'

describe('terminal generation recovery', () => {
  test('samples settlement time after acquiring the writer fence', async () => {
    const beforeFence = Date.parse('2026-09-03T13:29:59.999Z')
    const afterFence = Date.parse('2026-09-03T13:30:00.001Z')
    let settlementObservedAt: string | undefined
    const blockedIntents: BlockedCycleIntentStoreShape = {
      terminalizeUntouchedApproved: () => Effect.die('not used'),
      settleCurrentTerminalGeneration: (input) =>
        Effect.sync(() => {
          settlementObservedAt = input.observedAt
          return { _tag: 'NoTerminalGeneration' as const }
        }),
    }
    const authorityStore: AuthorityGenerationStoreShape = {
      ensureAuthorityGeneration: () => Effect.die('not used'),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: (effect) => TestClock.setTime(afterFence).pipe(Effect.andThen(effect)),
    }

    const receipt = await Effect.runPromise(
      TestClock.setTime(beforeFence).pipe(
        Effect.andThen(
          recoverTerminalGenerationToObserve({
            accountId: 'test-account',
            blockedIntents,
            authorityStore,
            writerFence,
            reconcileAfterSettlement: Effect.die('not used'),
          }),
        ),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(receipt).toEqual({ _tag: 'NotRequired' })
    expect(settlementObservedAt).toBe(utcInstantFromEpochMillis(afterFence))
  })
})
