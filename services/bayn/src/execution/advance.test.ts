import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import { CycleRunnerError, type CycleRunResult } from '../cycle/runner'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import { advanceExecutionOnce } from './advance'

const command = {
  controllerKey: 'primary',
  epoch: 4,
  sequence: 9,
  issuedAt: '2026-08-13T17:00:00.000Z',
  sourceRevision: 'a'.repeat(40),
} as const

const driver = (observation: AutonomousCyclePassObservation, result?: CycleRunResult, nextDelayMs = 30_000) => ({
  advance: Effect.succeed({ observation, ...(result === undefined ? {} : { result }) }),
  nextDelayMs,
})

type RecoveredCycle = Extract<CycleRunResult, { readonly outcome: 'RECOVERED' }>['cycle']

describe('advanceExecutionOnce', () => {
  test('returns a deterministic receipt for a completed pass', async () => {
    const observation = {
      result: 'SUCCESS' as const,
      outcome: 'RECOVERED' as const,
      observedAt: '2026-08-13T17:00:01.000Z',
    }
    const recovered = {
      outcome: 'RECOVERED' as const,
      action: 'ACTIVATED' as const,
      observedAt: observation.observedAt,
      cycle: {} as RecoveredCycle,
    }
    const first = await Effect.runPromise(advanceExecutionOnce(command, driver(observation, recovered)))
    const replay = await Effect.runPromise(advanceExecutionOnce(command, driver(observation, recovered)))

    expect(first).toEqual(replay)
    expect(first).toMatchObject({ _tag: 'Completed', nextDelayMs: 30_000, observation })
    expect(first.receiptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('classifies a closed window, recovery wait, and blocked recovery without inventing failures', async () => {
    const observedAt = '2026-08-13T17:00:01.000Z'
    const windowClosed = await Effect.runPromise(
      advanceExecutionOnce(command, driver({ result: 'SUCCESS', outcome: 'WINDOW_CLOSED', observedAt })),
    )
    const waiting = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver(
          { result: 'SUCCESS', outcome: 'RECOVERED', observedAt },
          { outcome: 'RECOVERED', action: 'WAITING', observedAt, cycle: {} as never },
        ),
      ),
    )
    const blocked = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver(
          { result: 'SUCCESS', outcome: 'RECOVERED', observedAt },
          { outcome: 'RECOVERED', action: 'BLOCKED', observedAt, cycle: {} as never },
        ),
      ),
    )

    expect(windowClosed).toMatchObject({ _tag: 'Blocked', reason: { _tag: 'WindowClosed' } })
    expect(waiting).toMatchObject({ _tag: 'Blocked', reason: { _tag: 'RecoveryWaiting' } })
    expect(blocked).toMatchObject({ _tag: 'Blocked', reason: { _tag: 'CycleBlocked' } })
  })

  test('uses the one-shot delay returned by the bounded pass', async () => {
    const observedAt = '2026-08-13T17:00:01.000Z'
    const outcome = await Effect.runPromise(
      advanceExecutionOnce(command, {
        advance: Effect.succeed({
          observation: { result: 'SUCCESS', outcome: 'RECOVERED', observedAt },
          result: { outcome: 'RECOVERED', action: 'WAITING', observedAt, cycle: {} as never },
          nextDelayMs: 300_000,
        }),
        nextDelayMs: 30_000,
      }),
    )

    expect(outcome).toMatchObject({ _tag: 'Blocked', nextDelayMs: 300_000 })
  })

  test('hashes only bounded failure facts and maps interpreter errors for Restate retry', async () => {
    const observedAt = '2026-08-13T17:00:01.000Z'
    const failed = (message: string) =>
      advanceExecutionOnce(
        command,
        driver({ result: 'FAILURE', operation: 'reconcile', failure: 'database', message, observedAt }),
      )
    const first = await Effect.runPromise(failed('untrusted detail one'))
    const second = await Effect.runPromise(failed('untrusted detail two'))
    expect(first).toMatchObject({
      _tag: 'Blocked',
      reason: { _tag: 'PassFailure', operation: 'reconcile', failure: 'database' },
    })
    expect(second.receiptHash).toBe(first.receiptHash)

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
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain('TransientExecutionFailure')
  })
})
