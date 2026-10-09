import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { CycleState, decodeAutonomousCycle } from '../cycle'
import { type CycleRunResult } from '../cycle/runner'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { advanceExecutionOnce } from '../execution/advance'
import {
  completeExecutionControllerTick,
  decodeExecutionControllerState,
  decideExecutionControllerActivation,
  decideExecutionControllerTick,
} from '../execution/controller'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { currentUtcInstant } from '../time'
import { decisionReadinessContinuationDelayMs, maximumHoldContinuationDelayMs } from './recovery-driver'

const native = nativeJevFixture(JevPurpose.Manage, '2026-09-04T14:30:32.000Z')
const observedAt = native.query.observedAt
const observedMs = Date.parse(observedAt)
const instant = (offset: number) => new Date(observedMs + offset).toISOString()
const cycle = Effect.runSync(
  decodeAutonomousCycle({
    ...native.draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
  }),
)
const waiting = (maximumHoldDueAt = instant(7_000)) =>
  ({
    outcome: 'RECOVERED',
    action: 'WAITING',
    cycle,
    observedAt,
    waitReason: 'JEV_POSITION_HELD',
    maximumHoldDueAt,
  }) as const

test('maximum hold caps a normal wait using the remaining time at the current pass sample', () => {
  expect(maximumHoldContinuationDelayMs(waiting(), 30_000, observedAt)).toBe(7_000)
  expect(maximumHoldContinuationDelayMs(waiting(), 30_000, instant(2_000))).toBe(5_000)
  expect(maximumHoldContinuationDelayMs(waiting(instant(1)), 30_000, observedAt)).toBe(1)
})

test.each([
  [3_000, 7_000, 3_000],
  [12_000, 7_000, 7_000],
  [7_000, 7_000, 7_000],
] as const)(
  'hold due at %i ms and signal ready at %i ms preserve the earlier continuation (%i ms)',
  (holdOffset, signalOffset, expected) => {
    const { waitReason: _waitReason, ...position } = waiting(instant(holdOffset))
    const result = {
      ...position,
      readiness: {
        reason: DecisionReadinessReason.SignalWindowObserved,
        message: 'The completed signal window was already consumed',
        availableAt: instant(signalOffset),
      },
    }
    const signalDelay = decisionReadinessContinuationDelayMs(result, 30_000, observedAt) ?? 30_000
    expect(maximumHoldContinuationDelayMs(result, signalDelay, observedAt) ?? signalDelay).toBe(expected)
  },
)

test.each([DecisionReadinessReason.DecisionPending, DecisionReadinessReason.SnapshotUnavailable])(
  'the actual hold deadline remains eligible during %s without granting data readiness',
  (reason) => {
    const { waitReason: _waitReason, ...position } = waiting()
    const result = { ...position, readiness: { reason, message: 'Evidence is still unavailable' } }
    expect(decisionReadinessContinuationDelayMs(result, 30_000, observedAt)).toBeUndefined()
    expect(maximumHoldContinuationDelayMs(result, 30_000, observedAt)).toBe(7_000)
    expect(result.readiness.reason).toBe(reason)
  },
)

test.each([-1, 0])('does not accelerate an elapsed hold deadline without an earlier evaluation (%i ms)', (offset) => {
  expect(maximumHoldContinuationDelayMs(waiting(instant(offset)), 30_000, observedAt)).toBeUndefined()
})

test.each([30_000, 30_001, 60_000])(
  'retains a future absolute hold deadline at %i ms while keeping the shorter normal cadence',
  (offset) => {
    expect(maximumHoldContinuationDelayMs(waiting(instant(offset)), 30_000, observedAt)).toBe(30_000)
  },
)

test.each([7_000, 8_000])(
  'a deadline crossed during the current evaluation gets one immediate wake at %i ms',
  (offset) => {
    const result = { ...waiting(), maximumHoldEvaluatedAt: observedAt }
    expect(maximumHoldContinuationDelayMs(result, 30_000, instant(offset))).toBe(1)
  },
)

test.each(['invalid', instant(7_000), instant(8_000), instant(10_000)])(
  'an elapsed hold cannot use an invalid, due-time, or future evaluation timestamp (%s)',
  (maximumHoldEvaluatedAt) => {
    expect(
      maximumHoldContinuationDelayMs({ ...waiting(), maximumHoldEvaluatedAt }, 30_000, instant(8_000)),
    ).toBeUndefined()
  },
)

test('rejects absent and invalid timing and preserves a shorter normal continuation', () => {
  const { maximumHoldDueAt: _maximumHoldDueAt, ...withoutDeadline } = waiting()
  expect(maximumHoldContinuationDelayMs(withoutDeadline, 30_000, observedAt)).toBeUndefined()
  expect(maximumHoldContinuationDelayMs(waiting('invalid'), 30_000, observedAt)).toBeUndefined()
  expect(maximumHoldContinuationDelayMs(waiting(), 30_000, 'invalid')).toBeUndefined()
  expect(maximumHoldContinuationDelayMs(waiting(), 1_000, observedAt)).toBe(1_000)
  expect(maximumHoldContinuationDelayMs(waiting(), 7_000, observedAt)).toBe(7_000)
})

test('uses the execution close bound, including valid hold deadlines after the entry cutoff', () => {
  const cutoff = Date.parse(cycle.window.submissionCutoffAt)
  expect(
    maximumHoldContinuationDelayMs(
      waiting(new Date(cutoff + 7_000).toISOString()),
      30_000,
      cycle.window.submissionCutoffAt,
    ),
  ).toBe(7_000)
  const close = Date.parse(cycle.window.executionCloseAt)
  for (const offset of [0, 1]) {
    expect(
      maximumHoldContinuationDelayMs(
        waiting(new Date(close + offset).toISOString()),
        30_000,
        new Date(close - 7_000).toISOString(),
      ),
    ).toBeUndefined()
  }
})

test('does not schedule hold continuations for non-waiting or terminal cycle results', () => {
  const results: CycleRunResult[] = [
    { outcome: 'WINDOW_CLOSED', observedAt },
    { outcome: 'ALREADY_TERMINAL', observedAt, cycle },
    { outcome: 'RECOVERED', action: 'COMPLETED', observedAt, cycle },
    { outcome: 'RECOVERED', action: 'BLOCKED', observedAt, cycle },
  ]
  for (const result of results) {
    expect(maximumHoldContinuationDelayMs({ ...result }, 30_000, observedAt)).toBeUndefined()
  }
})

test.each([7_000, 30_000, 30_001, 60_000])(
  'retains the absolute hold deadline at %i ms through the advance receipt and restarted durable controller',
  async (holdDelayMs) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(observedMs)
        const result = waiting(instant(holdDelayMs))
        const expectedDelayMs = Math.min(30_000, holdDelayMs)
        const command = {
          controllerKey: 'a'.repeat(64),
          epoch: 1,
          sequence: 0,
          issuedAt: observedAt,
          sourceRevision: 'd'.repeat(40),
        }
        const nextDelayMs = maximumHoldContinuationDelayMs(result, 30_000, yield* currentUtcInstant)
        const driver = {
          advance: Effect.succeed({
            result,
            observation: {
              result: 'SUCCESS',
              outcome: 'RECOVERED',
              recoveryAction: 'WAITING',
              observedAt,
              waitReason: result.waitReason,
            } as const,
            ...(nextDelayMs === undefined ? {} : { nextDelayMs, nextWakeAt: result.maximumHoldDueAt }),
          }),
          nextDelayMs: 30_000,
        }
        const outcome = yield* advanceExecutionOnce(command, driver)
        expect(outcome).toEqual(yield* advanceExecutionOnce(command, driver))
        expect(outcome.nextDelayMs).toBe(expectedDelayMs)
        expect(outcome.nextWakeAt).toBe(result.maximumHoldDueAt)
        const activated = Result.getOrThrow(
          decideExecutionControllerActivation(null, {
            schemaVersion: 'bayn.execution-controller-activation.v1',
            controllerKey: command.controllerKey,
            epoch: 1,
            firstSequence: 0,
            planHash: 'b'.repeat(64),
            sourceRevision: command.sourceRevision,
          }),
        ).state
        const completed = Result.getOrThrow(
          completeExecutionControllerTick(
            activated,
            { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
            {
              completedAt: observedAt,
              outcome: {
                _tag: ExecutionControllerOutcome.Waiting,
                receiptHash: outcome.receiptHash,
                nextDelayMs: outcome.nextDelayMs,
                ...(outcome.nextWakeAt === undefined ? {} : { nextWakeAt: outcome.nextWakeAt }),
              },
            },
            command.sourceRevision,
          ),
        )
        const restarted = Result.getOrThrow(decodeExecutionControllerState(JSON.parse(JSON.stringify(completed))))
        expect(restarted.nextDueAt).toBe(instant(expectedDelayMs))
        expect(restarted.nextSequence).toBe(1)
        expect(
          Result.getOrThrow(
            decideExecutionControllerTick(
              restarted,
              { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
              command.controllerKey,
              result.maximumHoldDueAt,
              command.sourceRevision,
            ),
          ),
        ).toEqual({ _tag: 'Ignored', reason: 'StaleSequence' })
        yield* TestClock.adjust(expectedDelayMs)
        expect(
          Result.getOrThrow(
            decideExecutionControllerTick(
              restarted,
              { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 1 },
              command.controllerKey,
              yield* currentUtcInstant,
              command.sourceRevision,
            ),
          )._tag,
        ).toBe('Advance')
        if (holdDelayMs > expectedDelayMs) {
          expect(maximumHoldContinuationDelayMs(result, 30_000, yield* currentUtcInstant)).toBe(
            Math.min(30_000, holdDelayMs - expectedDelayMs),
          )
          yield* TestClock.adjust(holdDelayMs - expectedDelayMs)
        }
        // The single wake cannot turn an old deadline into an overdue retry loop.
        expect(maximumHoldContinuationDelayMs(result, 30_000, yield* currentUtcInstant)).toBeUndefined()
        yield* TestClock.adjust(1)
        expect(maximumHoldContinuationDelayMs(result, 30_000, yield* currentUtcInstant)).toBeUndefined()
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },
)
