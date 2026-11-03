import { strictParseOptions } from '../schemas'
import { expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { CycleState, AutonomousCycleSchema } from '../cycle/model'
import { unusedEntryExpiresAt, hasExpiredUnusedEntryAdmission } from '../cycle/entry-admission'
import { type CycleRunResult } from '../cycle/runner/model'
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

const native = nativeJevFixture(undefined, '2026-09-04T14:56:54.802Z')
const observedAt = native.query.observedAt
const observedMs = Date.parse(observedAt)
const instant = (offset: number) => new Date(observedMs + offset).toISOString()
const cycle = Effect.runSync(
  Schema.decodeUnknownEffect(
    AutonomousCycleSchema,
    strictParseOptions,
  )({
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
      reason !== DecisionReadinessReason.LookbackWarmup &&
      reason !== DecisionReadinessReason.SignalWindowObserved &&
      reason !== DecisionReadinessReason.InferenceExpired,
  ),
)('preserves the ordinary retry cadence for %s, even with a timestamp', (reason) => {
  expect(decisionReadinessContinuationDelayMs(waiting(reason), 30_000, observedAt)).toBeUndefined()
})

test('retries expired inference within the original unused entry deadline instead of the ordinary poll', () => {
  const result = waiting(DecisionReadinessReason.InferenceExpired)
  expect(decisionReadinessContinuationDelayMs(result, 30_000, observedAt)).toBe(1)
  const expiresAt = unusedEntryExpiresAt(cycle)
  for (const at of [expiresAt, expiresAt + 1])
    expect(decisionReadinessContinuationDelayMs(result, 30_000, new Date(at).toISOString())).toBeUndefined()
  expect(decisionReadinessContinuationDelayMs(result, 30_000, instant(-1))).toBeUndefined()
  expect(decisionReadinessContinuationDelayMs(result, 30_000, 'invalid')).toBeUndefined()
  for (const bound of [{ snapshotId: 'a'.repeat(64) }, { decisionHash: 'b'.repeat(64) }])
    expect(
      decisionReadinessContinuationDelayMs({ ...result, cycle: { ...cycle, bindings: bound } }, 30_000, observedAt),
    ).toBeUndefined()
})

const pendingInputs = (previousWindowEndAt?: string) => ({
  ...waiting(DecisionReadinessReason.SnapshotUnavailable),
  readiness: {
    reason: DecisionReadinessReason.SnapshotUnavailable,
    message: 'No candidate has complete raw data and a matching rolling feature',
    snapshotQuery: {
      rangeStartAt: native.query.rangeStartAt,
      rangeEndAt: native.query.rangeEndAt,
      symbols: native.query.symbols ?? native.query.universe,
      ...(previousWindowEndAt === undefined ? {} : { previousWindowEndAt }),
    },
  },
})

test.each([undefined, native.query.rangeEndAt, instant(60_000), 'invalid'])(
  'initial or already consumed missing inputs keep the ordinary cadence (%s)',
  (previousWindowEndAt) => {
    const result = pendingInputs(previousWindowEndAt)
    expect(decisionReadinessContinuationDelayMs(result, 30_000, instant(37_171))).toBeUndefined()
  },
)

test('rechecks pending snapshot inputs before the captured remaining admission expires', () => {
  // The retained 16:24 cycle had 22,829 ms left when its next feature cut was unavailable.
  const checkedAt = instant(37_171)
  const result = pendingInputs(instant(-60_000))
  expect(decisionReadinessContinuationDelayMs(result, 30_000, checkedAt)).toBe(1_000)
  expect(Date.parse(checkedAt) + 30_000).toBeGreaterThan(unusedEntryExpiresAt(cycle))
  expect(decisionReadinessContinuationDelayMs(result, 500, checkedAt)).toBe(500)
  expect(decisionReadinessContinuationDelayMs(result, 30_000, instant(59_900))).toBe(100)
  expect(decisionReadinessContinuationDelayMs(result, 30_000, instant(60_000))).toBeUndefined()
  expect(decisionReadinessContinuationDelayMs(result, 30_000, instant(-1))).toBeUndefined()
  expect(decisionReadinessContinuationDelayMs(result, 30_000, 'invalid')).toBeUndefined()
  for (const state of [CycleState.Pending, CycleState.NoTrade, CycleState.Completed, CycleState.Blocked])
    expect(
      decisionReadinessContinuationDelayMs({ ...result, cycle: { ...cycle, state } }, 30_000, checkedAt),
    ).toBeUndefined()
  for (const bindings of [{ snapshotId: 'a'.repeat(64) }, { decisionHash: 'b'.repeat(64) }])
    expect(
      decisionReadinessContinuationDelayMs({ ...result, cycle: { ...cycle, bindings } }, 30_000, checkedAt),
    ).toBeUndefined()
})

test('the captured late-commit retry pattern finishes before the unchanged entry expiry', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const firstCompletedMs = observedMs + 12_548
      yield* TestClock.setTime(firstCompletedMs)
      const result = waiting(DecisionReadinessReason.InferenceExpired)
      const delay = decisionReadinessContinuationDelayMs(result, 30_000, yield* currentUtcInstant)
      expect(delay).toBe(1)
      if (delay === undefined) return yield* Effect.die('Expired inference requires a continuation')
      const command = {
        controllerKey: 'a'.repeat(64),
        epoch: 1,
        sequence: 0,
        issuedAt: instant(0),
        sourceRevision: 'd'.repeat(40),
      }
      const outcome = yield* advanceExecutionOnce(command, {
        advance: Effect.succeed({
          result,
          nextDelayMs: delay,
          observation: {
            result: 'SUCCESS',
            outcome: 'RECOVERED',
            recoveryAction: 'WAITING',
            observedAt: instant(12_548),
            readiness: result.readiness,
          } as const,
        }),
        nextDelayMs: 30_000,
      })
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
            completedAt: instant(12_548),
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
      expect(restarted.nextDueAt).toBe(instant(12_549))
      const remainingWorkMs = 8_781 + 6_475 + 3_535
      const normalCompletion = instant(12_548 + 30_000 + remainingWorkMs)
      yield* TestClock.adjust(outcome.nextDelayMs + remainingWorkMs)
      expect(hasExpiredUnusedEntryAdmission(cycle, normalCompletion)).toBe(true)
      expect(hasExpiredUnusedEntryAdmission(cycle, yield* currentUtcInstant)).toBe(false)
      expect(unusedEntryExpiresAt(cycle)).toBe(observedMs + 60_000)
    }).pipe(Effect.provide(TestClock.layer())),
  )
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
