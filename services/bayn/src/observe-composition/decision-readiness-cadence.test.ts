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
import { currentUtcInstant } from '../time'
import { decisionReadinessContinuationDelayMs } from './recovery-driver'

const native = nativeJevFixture()
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
const waiting = (
  reason = DecisionReadinessReason.SignalWindowObserved,
  availableAt: string | undefined = instant(7_000),
) =>
  ({
    outcome: 'RECOVERED',
    action: 'WAITING',
    cycle,
    observedAt,
    readiness: {
      reason,
      message: 'Awaiting a fresh signal window',
      ...(availableAt === undefined ? {} : { availableAt }),
    },
  }) as const

test.each([DecisionReadinessReason.SignalWindowObserved, DecisionReadinessReason.LookbackWarmup])(
  '%s schedules the known future boundary before the normal poll',
  (reason) => {
    expect(decisionReadinessContinuationDelayMs(waiting(reason), 30_000, observedAt)).toBe(7_000)
    expect(decisionReadinessContinuationDelayMs(waiting(reason), 5_000, observedAt)).toBeUndefined()
    expect(decisionReadinessContinuationDelayMs(waiting(reason), 7_000, observedAt)).toBeUndefined()
    expect(decisionReadinessContinuationDelayMs(waiting(reason), 30_000, instant(2_000))).toBe(5_000)
  },
)

test.each([-1, 0, 30_000, 60_000])('does not accelerate an elapsed or later boundary (%i ms)', (offset) => {
  expect(
    decisionReadinessContinuationDelayMs(
      waiting(DecisionReadinessReason.SignalWindowObserved, instant(offset)),
      30_000,
      observedAt,
    ),
  ).toBeUndefined()
})

test('rejects missing or invalid timing and boundaries outside the entry session', () => {
  const noTime = waiting()
  const { availableAt: _availableAt, ...readiness } = noTime.readiness
  expect(decisionReadinessContinuationDelayMs({ ...noTime, readiness }, 30_000, observedAt)).toBeUndefined()
  expect(decisionReadinessContinuationDelayMs(waiting(undefined, 'invalid'), 30_000, observedAt)).toBeUndefined()
  expect(decisionReadinessContinuationDelayMs(waiting(), 30_000, 'invalid')).toBeUndefined()
  const cutoffMs = Date.parse(cycle.window.submissionCutoffAt)
  for (const offset of [0, 1]) {
    expect(
      decisionReadinessContinuationDelayMs(
        waiting(undefined, new Date(cutoffMs + offset).toISOString()),
        30_000,
        new Date(cutoffMs - 7_000).toISOString(),
      ),
    ).toBeUndefined()
  }
})

test.each(
  Object.values(DecisionReadinessReason).filter(
    (reason) =>
      reason !== DecisionReadinessReason.LookbackWarmup && reason !== DecisionReadinessReason.SignalWindowObserved,
  ),
)('preserves the ordinary retry cadence for %s, even with a timestamp', (reason) => {
  expect(decisionReadinessContinuationDelayMs(waiting(reason), 30_000, observedAt)).toBeUndefined()
})

test('does not accelerate non-readiness waits, terminal results or closed windows', () => {
  const results: CycleRunResult[] = [
    { outcome: 'WINDOW_CLOSED', observedAt },
    { outcome: 'ALREADY_TERMINAL', observedAt, cycle },
    { outcome: 'RECOVERED', action: 'COMPLETED', observedAt, cycle },
    { outcome: 'RECOVERED', action: 'BLOCKED', observedAt, cycle },
    { outcome: 'RECOVERED', action: 'WAITING', waitReason: 'JEV_POSITION_HELD', observedAt, cycle },
  ]
  for (const result of results) expect(decisionReadinessContinuationDelayMs(result, 30_000, observedAt)).toBeUndefined()
})

test('persists a one-shot boundary wake through the existing receipt and restart-safe controller chain', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(observedMs)
      const result = waiting()
      const command = {
        controllerKey: 'a'.repeat(64),
        epoch: 1,
        sequence: 0,
        issuedAt: observedAt,
        sourceRevision: 'd'.repeat(40),
      }
      const nextDelayMs = decisionReadinessContinuationDelayMs(result, 30_000, yield* currentUtcInstant)
      const driver = {
        advance: Effect.succeed({
          result,
          observation: {
            result: 'SUCCESS',
            outcome: 'RECOVERED',
            recoveryAction: 'WAITING',
            observedAt,
            readiness: result.readiness,
          } as const,
          ...(nextDelayMs === undefined ? {} : { nextDelayMs }),
        }),
        nextDelayMs: 30_000,
      }
      const outcome = yield* advanceExecutionOnce(command, driver)
      const replay = yield* advanceExecutionOnce(command, driver)
      expect(outcome).toEqual(replay)
      expect(outcome.nextDelayMs).toBe(7_000)
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
            },
          },
          command.sourceRevision,
        ),
      )
      const restarted = Result.getOrThrow(decodeExecutionControllerState(JSON.parse(JSON.stringify(completed))))
      expect(restarted.nextDueAt).toBe(result.readiness.availableAt)
      expect(restarted.nextSequence).toBe(1)
      expect(
        Result.getOrThrow(
          decideExecutionControllerTick(
            restarted,
            { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
            command.controllerKey,
            result.readiness.availableAt ?? '',
            command.sourceRevision,
          ),
        )._tag,
      ).toBe('Ignored')
      yield* TestClock.adjust(7_000)
      // A stale readiness result cannot spin on the consumed instant after the single durable wake.
      expect(decisionReadinessContinuationDelayMs(result, 30_000, yield* currentUtcInstant)).toBeUndefined()
    }).pipe(Effect.provide(TestClock.layer())),
  )
})
