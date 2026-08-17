import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import { CycleRunnerError } from '../cycle/runner'
import { CycleState } from '../cycle/model'
import { CycleNotDueReason } from '../cycle/runner/model'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import { advanceExecutionOnce } from './advance'

const command = {
  controllerKey: 'primary',
  epoch: 4,
  sequence: 9,
  issuedAt: '2026-08-13T17:00:00.000Z',
  sourceRevision: 'a'.repeat(40),
} as const

const driver = (
  observation: AutonomousCyclePassObservation,
  result?:
    | { readonly outcome: 'RECOVERED'; readonly action: 'BLOCKED' | 'WAITING' }
    | {
        readonly outcome: 'ACQUIRED' | 'REACQUIRED' | 'RESUMED'
        readonly readiness: { readonly outcome: 'ALREADY_BOUND' | 'BLOCKED' | 'BOUND' }
      }
    | {
        readonly outcome: 'ALREADY_TERMINAL'
        readonly cycle: { readonly state: CycleState.Blocked | CycleState.Completed | CycleState.NoTrade }
      },
) => ({
  advance: Effect.succeed({ observation, ...(result === undefined ? {} : { result }) }),
  nextDelayMs: 30_000,
})

describe('advanceExecutionOnce', () => {
  test('returns one deterministic completed receipt for a completed pass', async () => {
    const observation = {
      result: 'SUCCESS' as const,
      outcome: 'RECOVERED' as const,
      observedAt: '2026-08-13T17:00:01.000Z',
    }
    const first = await Effect.runPromise(advanceExecutionOnce(command, driver(observation)))
    const replay = await Effect.runPromise(advanceExecutionOnce(command, driver(observation)))

    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      _tag: 'Completed',
      nextDelayMs: 30_000,
      observation,
    })
    expect(first.receiptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('persists a one-shot Restate delay returned by the completed advance', async () => {
    const observation = {
      result: 'SUCCESS' as const,
      outcome: 'RECOVERED' as const,
      observedAt: '2026-08-13T17:00:01.000Z',
    }
    const result = await Effect.runPromise(
      advanceExecutionOnce(command, {
        advance: Effect.succeed({
          observation,
          result: { outcome: 'RECOVERED' as const, action: 'WAITING' as const },
          nextDelayMs: 300_000,
        }),
        nextDelayMs: 30_000,
      }),
    )

    expect(result).toMatchObject({
      _tag: 'Blocked',
      reason: { _tag: 'RecoveryWaiting' },
      nextDelayMs: 300_000,
    })
  })

  test('classifies expected business waits without exposing arbitrary failure messages', async () => {
    const notDue = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver({
          result: 'SUCCESS',
          outcome: 'NOT_DUE',
          notDueReason: CycleNotDueReason.MonthEndCadence,
          observedAt: '2026-08-13T17:00:01.000Z',
        }),
      ),
    )
    const failedObservation = {
      result: 'FAILURE' as const,
      operation: 'reconcile-not-due' as const,
      failure: 'database' as const,
      message: 'untrusted database detail',
      observedAt: '2026-08-13T17:00:01.000Z',
    }
    const failed = await Effect.runPromise(advanceExecutionOnce(command, driver(failedObservation)))

    expect(notDue).toMatchObject({
      _tag: 'Blocked',
      reason: { _tag: 'NotDue', reason: CycleNotDueReason.MonthEndCadence },
    })
    expect(failed).toMatchObject({
      _tag: 'Blocked',
      reason: { _tag: 'PassFailure', operation: 'reconcile-not-due', failure: 'database' },
    })
    expect(failed.receiptHash).toBe(
      (
        await Effect.runPromise(
          advanceExecutionOnce(
            command,
            driver({
              ...failedObservation,
              message: 'a different untrusted database detail',
            }),
          ),
        )
      ).receiptHash,
    )

    const waiting = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver(
          { result: 'SUCCESS', outcome: 'RECOVERED', observedAt: '2026-08-13T17:00:01.000Z' },
          { outcome: 'RECOVERED', action: 'WAITING' },
        ),
      ),
    )
    const blocked = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver(
          { result: 'SUCCESS', outcome: 'RECOVERED', observedAt: '2026-08-13T17:00:01.000Z' },
          { outcome: 'RECOVERED', action: 'BLOCKED' },
        ),
      ),
    )
    expect(waiting).toMatchObject({ _tag: 'Blocked', reason: { _tag: 'RecoveryWaiting' } })
    expect(blocked).toMatchObject({ _tag: 'Blocked', reason: { _tag: 'CycleBlocked' } })
  })

  test('retains blocked publication readiness for every acquisition result', async () => {
    const outcomes = await Promise.all(
      (['ACQUIRED', 'REACQUIRED', 'RESUMED'] as const).map((outcome) =>
        Effect.runPromise(
          advanceExecutionOnce(
            command,
            driver(
              { result: 'SUCCESS', outcome, observedAt: '2026-08-13T17:00:01.000Z' },
              { outcome, readiness: { outcome: 'BLOCKED' } },
            ),
          ),
        ),
      ),
    )
    const bound = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver(
          { result: 'SUCCESS', outcome: 'ACQUIRED', observedAt: '2026-08-13T17:00:01.000Z' },
          { outcome: 'ACQUIRED', readiness: { outcome: 'BOUND' } },
        ),
      ),
    )

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ _tag: 'Blocked', reason: { _tag: 'CycleBlocked' } })
    }
    expect(bound).toMatchObject({ _tag: 'Completed' })
    expect(outcomes[0]?.receiptHash).not.toBe(bound.receiptHash)
  })

  test('distinguishes a blocked terminal cycle from successful terminal states', async () => {
    const observation = {
      result: 'SUCCESS' as const,
      outcome: 'ALREADY_TERMINAL' as const,
      observedAt: '2026-08-13T17:00:01.000Z',
    }
    const blocked = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver(observation, { outcome: 'ALREADY_TERMINAL', cycle: { state: CycleState.Blocked } }),
      ),
    )
    const completed = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver(observation, { outcome: 'ALREADY_TERMINAL', cycle: { state: CycleState.Completed } }),
      ),
    )

    expect(blocked).toMatchObject({ _tag: 'Blocked', reason: { _tag: 'CycleBlocked' } })
    expect(completed).toMatchObject({ _tag: 'Completed' })
    expect(blocked.receiptHash).not.toBe(completed.receiptHash)
  })

  test('keeps interpreter failures typed for Restate retry policy', async () => {
    const exit = await Effect.runPromiseExit(
      advanceExecutionOnce(command, {
        advance: Effect.fail(
          new CycleRunnerError({
            operation: 'run-cycle-pass',
            failure: 'operational',
            message: 'aggregate execution deadline exceeded',
          }),
        ),
        nextDelayMs: 30_000,
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain('TransientExecutionFailure')
    }
  })
})
