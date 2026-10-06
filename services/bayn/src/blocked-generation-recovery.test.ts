import { describe, expect, test } from 'bun:test'

import { Effect, Result } from 'effect'
import { TestClock } from 'effect/testing'

import type { AuthorityGenerationStoreShape } from './db/execution-store'
import type { BlockedCycleIntentStoreShape } from './execution/intents'
import type { WriterFenceService } from './execution/writer-fence'
import {
  advanceRestrictedGenerationRecovery,
  executionObserveSuccessorGenerationHash,
  recoverTerminalGenerationToObserve,
} from './blocked-generation-recovery'
import { refreshResearchCapitalActivationReconciliation } from './composition/capital-activation'
import { makeGenerationCycleDriver } from './composition/generation-cycle'
import { Authority, KillState, ReconciliationStatus, type AuthorityState } from './execution/contracts'
import { OperationalError } from './errors'
import { reconcileReplayForActivation } from './intraday-replay/runtime'
import type { RecoveryFirstCycleAdvance } from './observe-composition'
import { utcInstantFromEpochMillis } from './time'

describe('terminal generation recovery', () => {
  test.each(['production', 'replay'] as const)('keeps %s restricted until exact reconciliation', async (runtime) => {
    const generationHash = 'a'.repeat(64)
    const preserveCyclePlanHash = 'b'.repeat(64)
    const successorGenerationHash = Result.getOrThrow(
      executionObserveSuccessorGenerationHash({ previousExecutionGenerationHash: generationHash }),
    )
    const restricted: AuthorityState = {
      schemaVersion: 'bayn.paper-authority.v1',
      generationHash,
      maximum: Authority.Execution,
      effective: Authority.Observe,
      kill: KillState.Active,
      reason: `reconciliation discrepancy ${'c'.repeat(64)}`,
      version: 2,
      updatedAt: '2026-09-03T07:00:00.000Z',
    }
    let authority = restricted
    let reconciliationStatus = ReconciliationStatus.Discrepancy
    let settlements = 0
    let reconciliations = 0
    let rollovers = 0
    const reconcile = refreshResearchCapitalActivationReconciliation(
      Effect.sync(() => {
        reconciliations += 1
        return { report: { reconciliation: { status: reconciliationStatus } } }
      }),
      1000,
    ).pipe(Effect.asVoid)
    const settle = recoverTerminalGenerationToObserve({
      accountId: 'test-account',
      blockedIntents: {
        terminalizeUntouchedApproved: () => Effect.die('no entry intent may be changed'),
        settleCurrentTerminalGeneration: () =>
          Effect.sync(() => {
            settlements += 1
            return {
              _tag: 'TerminalGenerationSettled' as const,
              authorityGenerationHash: generationHash,
              preserveCyclePlanHash,
              blockedCycleCount: 0,
              blockedIntentCount: 0,
              expiredIntentCount: 0,
              intentCount: 0,
              terminalIntentCount: 0,
            }
          }),
      },
      authorityStore: {
        ensureAuthorityGeneration: (input) =>
          Effect.sync(() => {
            expect(input).toEqual({
              generationHash: successorGenerationHash,
              maximum: Authority.Observe,
              preserveCyclePlanHash,
            })
            rollovers += 1
            authority = {
              ...restricted,
              generationHash: successorGenerationHash,
              maximum: Authority.Observe,
              kill: KillState.Clear,
              version: 3,
            }
            return authority
          }),
      },
      writerFence: { check: Effect.void, transaction: (effect) => effect },
      reconcileAfterSettlement:
        runtime === 'replay'
          ? reconcileReplayForActivation(Effect.succeed(restricted.updatedAt), reconcile)
          : reconcile,
    })
    const advanced: RecoveryFirstCycleAdvance = {
      observation: {
        result: 'SUCCESS',
        observedAt: restricted.updatedAt,
        outcome: 'RECOVERED',
        recoveryAction: 'WAITING',
        waitReason: 'reconciliation-not-exact',
      },
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const owned = yield* makeGenerationCycleDriver(
          {
            generationHash,
            mode: 'CloseOnly',
            readAuthority: Effect.sync(() => authority),
            reconcileWhenHeld: Effect.die('not an operator hold'),
            settle,
          },
          {
            advance: Effect.succeed(advanced),
            nextDelayMs: 30_000,
            timeoutMs: 30_000,
            onTimeout: (error) => Effect.fail(error),
          },
        )
        for (let pass = 0; pass < 3; pass += 1) {
          expect(yield* owned.driver.advance).toEqual(advanced)
          expect(yield* owned.needsRebind).toBe(false)
          expect(owned.driver.nextDelayMs).toBe(30_000)
          expect(authority).toEqual(restricted)
          expect(rollovers).toBe(0)
          yield* TestClock.adjust(30_000)
        }
        reconciliationStatus = ReconciliationStatus.Exact
        expect(yield* owned.driver.advance).toEqual(advanced)
        expect(yield* owned.needsRebind).toBe(true)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(settlements).toBe(4)
    expect(reconciliations).toBe(4)
    expect(rollovers).toBe(1)
    expect(authority.kill).toBe(KillState.Clear)
  })

  test.each(['production', 'replay'] as const)('propagates %s reconciliation database failures', async (runtime) => {
    const failure = new OperationalError({
      component: 'database',
      operation: 'reconcile',
      message: 'database unavailable',
      retryable: true,
    })
    const reconcile = refreshResearchCapitalActivationReconciliation(Effect.fail(failure), 1000)
    const settle = (
      runtime === 'replay'
        ? reconcileReplayForActivation(Effect.succeed('2026-09-03T07:00:00.000Z'), reconcile)
        : reconcile
    ).pipe(Effect.as({ _tag: 'NotRequired' as const }))
    const result = await Effect.runPromise(
      advanceRestrictedGenerationRecovery(Effect.succeed('advanced'), settle).pipe(Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      if (runtime === 'replay') {
        expect(result.failure.operation).toBe('replay-generation-recovery')
        expect(result.failure.cause).toBeInstanceOf(OperationalError)
        if (result.failure.cause instanceof OperationalError) expect(result.failure.cause.cause).toBe(failure)
      } else {
        expect(result.failure.cause).toBe(failure)
      }
    }
  })

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
