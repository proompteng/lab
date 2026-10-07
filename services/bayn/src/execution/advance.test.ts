import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Logger, References, Tracer } from 'effect'
import { TestClock } from 'effect/testing'

import { CycleRunnerError, type CycleRunResult } from '../cycle/runner'
import type { AutonomousCyclePassObservation } from '../runtime-state'
import { withObservedStage } from '../telemetry'
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
  for (const failure of ['typed', 'defect', 'interruption'] as const) {
    test(`reports the final stage profile once after ${failure} failure`, async () => {
      const records: Readonly<Record<string, unknown>>[] = []
      let finalized = 0
      const logger = Logger.make(({ fiber, message }) => {
        if (JSON.stringify(message).includes('Bayn execution advance did not complete'))
          records.push(fiber.getRef(References.CurrentLogAnnotations))
      })
      const error = new CycleRunnerError({
        operation: 'run-cycle-pass',
        failure: 'operational',
        message: 'injected failure',
      })
      const exit = await Effect.runPromise(
        advanceExecutionOnce(command, {
          advance: TestClock.adjust(250).pipe(
            Effect.andThen(
              failure === 'typed' ? Effect.fail(error) : failure === 'defect' ? Effect.die(error) : Effect.interrupt,
            ),
            Effect.ensuring(
              Effect.sync(() => {
                finalized += 1
              }),
            ),
            withObservedStage('bayn.alpaca.mutation', { dependency: 'alpaca', operation: 'SUBMIT' }),
          ),
          nextDelayMs: 30_000,
        }).pipe(Effect.exit, Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
      )
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(finalized).toBe(1)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        outcome: failure === 'interruption' ? 'Interrupted' : 'Failed',
        elapsedMs: 250,
        stageTimings: [
          {
            stage: 'bayn.alpaca.mutation',
            dependency: 'alpaca',
            operation: 'SUBMIT',
            count: 1,
            inclusiveElapsedMs: 250,
            maxElapsedMs: 250,
            failures: failure === 'interruption' ? 0 : 1,
            interruptions: failure === 'interruption' ? 1 : 0,
          },
        ],
      })
    })
  }

  test('reports correlated timings and resets the stage profile for every pass', async () => {
    const records: Readonly<Record<string, unknown>>[] = []
    const spans: Tracer.Span[] = []
    const logger = Logger.make(({ fiber, message }) => {
      if (
        Array.isArray(message)
          ? message.includes('Bayn execution advance completed')
          : message === 'Bayn execution advance completed'
      )
        records.push(fiber.getRef(References.CurrentLogAnnotations))
    })
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const observation = { result: 'SUCCESS' as const, outcome: 'WINDOW_CLOSED' as const, observedAt: command.issuedAt }
    await Effect.runPromise(
      Effect.gen(function* () {
        for (const elapsedMs of [250, 10]) {
          yield* advanceExecutionOnce(command, {
            advance: TestClock.adjust(elapsedMs).pipe(
              Effect.as({ observation }),
              withObservedStage('bayn.execution-store.operation', { dependency: 'postgresql' }),
            ),
            nextDelayMs: 30_000,
          })
        }
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(Tracer.Tracer, tracer),
      ),
    )
    expect(records).toHaveLength(2)
    for (const [index, elapsedMs] of [250, 10].entries()) {
      expect(records[index]).toMatchObject({
        controllerKey: command.controllerKey,
        epoch: command.epoch,
        sequence: command.sequence,
        sourceRevision: command.sourceRevision,
        outcome: 'Waiting',
        nextDelayMs: 30_000,
        elapsedMs,
        stageTimings: [
          {
            stage: 'bayn.execution-store.operation',
            dependency: 'postgresql',
            count: 1,
            inclusiveElapsedMs: elapsedMs,
            maxElapsedMs: elapsedMs,
            failures: 0,
            interruptions: 0,
          },
        ],
      })
      expect(records[index]?.['trace_id']).toMatch(/^[0-9a-f]{32}$/)
    }
    expect(
      spans
        .filter((span) => span.name === 'bayn.execution-store.operation')
        .every((span) => span.attributes.get('bayn.dependency') === 'postgresql'),
    ).toBeTrue()
  })

  test('binds retained Jev references without changing legacy receipt bytes', async () => {
    const observation = {
      result: 'SUCCESS' as const,
      outcome: 'WINDOW_CLOSED' as const,
      observedAt: '2026-08-13T17:00:01.000Z',
    }
    const legacy = await Effect.runPromise(advanceExecutionOnce(command, driver(observation)))
    const retained = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver({ ...observation, jevObservationReferences: { hashes: ['a'.repeat(64)], complete: true } }),
      ),
    )
    expect(legacy.receiptHash).toBe('51e21e1ae5fa32e4feee03b56ce8b322ec709c1492956958a9ada7125acb69f0')
    expect(retained.receiptHash).not.toBe(legacy.receiptHash)
  })

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
          {
            outcome: 'RECOVERED',
            action: 'WAITING',
            waitReason: 'AWAITING_SUBMISSION_OPEN',
            observedAt,
            cycle: {} as never,
          },
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

    expect(windowClosed).toMatchObject({ _tag: 'Waiting', reason: { _tag: 'WindowClosed' } })
    expect(waiting).toMatchObject({ _tag: 'Waiting', reason: { _tag: 'RecoveryWaiting' } })
    expect(blocked).toMatchObject({ _tag: 'Blocked', reason: { _tag: 'CycleBlocked' } })
  })

  test('uses the one-shot delay returned by the bounded pass', async () => {
    const observedAt = '2026-08-13T17:00:01.000Z'
    const outcome = await Effect.runPromise(
      advanceExecutionOnce(command, {
        advance: Effect.succeed({
          observation: { result: 'SUCCESS', outcome: 'RECOVERED', observedAt },
          result: {
            outcome: 'RECOVERED',
            action: 'WAITING',
            waitReason: 'AWAITING_SUBMISSION_OPEN',
            observedAt,
            cycle: {} as never,
          },
          nextDelayMs: 300_000,
        }),
        nextDelayMs: 30_000,
      }),
    )

    expect(outcome).toMatchObject({ _tag: 'Waiting', nextDelayMs: 300_000 })
  })

  test('retains holding status without a transient cycle result and binds its reason into the receipt', async () => {
    const observation = {
      result: 'SUCCESS',
      outcome: 'RECOVERED',
      recoveryAction: 'WAITING',
      observedAt: '2026-08-13T17:00:01.000Z',
      waitReason: 'ENTRY_INTENTS_SETTLED_UNTIL_CLOSE',
    } as const
    const holding = await Effect.runPromise(advanceExecutionOnce(command, driver(observation)))
    const settling = await Effect.runPromise(
      advanceExecutionOnce(
        command,
        driver({
          ...observation,
          waitReason: 'POST_MUTATION_RECONCILIATION',
        }),
      ),
    )
    expect(holding).toMatchObject({ _tag: 'Waiting', observation })
    expect(settling.receiptHash).not.toBe(holding.receiptHash)
  })

  test('a pending broker cut remains a waiting receipt after the transient result is discarded', async () => {
    const observation = {
      result: 'SUCCESS',
      outcome: 'WAITING',
      observedAt: '2026-08-13T17:00:01.000Z',
      waitReason: 'BROKER_OBSERVATION_PENDING',
    } as const
    const first = await Effect.runPromise(advanceExecutionOnce(command, driver(observation)))
    const replay = await Effect.runPromise(advanceExecutionOnce(command, driver(observation)))
    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      _tag: 'Waiting',
      reason: { _tag: 'RecoveryWaiting' },
      observation,
      nextDelayMs: 30_000,
    })
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
