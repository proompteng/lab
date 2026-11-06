import { strictParseOptions } from '../schemas'
import { expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { CycleState, CycleTerminalReason, AutonomousCycleSchema } from '../cycle/model'
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
import { decisionReadinessContinuationDelayMs, unusedEntryHandoffDelayMs } from './recovery-driver'

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
  reason: Exclude<
    DecisionReadinessReason,
    DecisionReadinessReason.ExecutionRiskExpired
  > = DecisionReadinessReason.SignalWindowObserved,
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

test('unused-entry handoff accelerates only an expired, unbound block before the original cutoff', () => {
  const expired = {
    outcome: 'RECOVERED',
    action: 'BLOCKED',
    observedAt: instant(60_000),
    cycle: {
      ...cycle,
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.UnusedEntryExpired,
    },
  } as const
  expect(unusedEntryHandoffDelayMs(expired, 30_000, instant(60_000))).toBe(1)
  expect(unusedEntryHandoffDelayMs(expired, 30_000, instant(59_999))).toBeUndefined()
  expect(unusedEntryHandoffDelayMs(expired, 30_000, cycle.window.submissionCutoffAt)).toBeUndefined()
  expect(
    unusedEntryHandoffDelayMs(
      { ...expired, cycle: { ...expired.cycle, state: CycleState.Active } },
      30_000,
      instant(60_000),
    ),
  ).toBeUndefined()
  expect(
    unusedEntryHandoffDelayMs(
      { ...expired, cycle: { ...expired.cycle, terminalReason: CycleTerminalReason.Risk } },
      30_000,
      instant(60_000),
    ),
  ).toBeUndefined()
  for (const bindings of [{ snapshotId: '1'.repeat(64) }, { decisionHash: '2'.repeat(64) }])
    expect(
      unusedEntryHandoffDelayMs({ ...expired, cycle: { ...expired.cycle, bindings } }, 30_000, instant(60_000)),
    ).toBeUndefined()
})

test.each([DecisionReadinessReason.SignalWindowObserved, DecisionReadinessReason.LookbackWarmup])(
  '%s schedules the known future boundary before the normal poll',
  (reason) => {
    expect(decisionReadinessContinuationDelayMs(waiting(reason), 30_000, observedAt)).toBe(7_000)
    expect(decisionReadinessContinuationDelayMs(waiting(reason), 5_000, observedAt)).toBeUndefined()
    expect(decisionReadinessContinuationDelayMs(waiting(reason), 7_000, observedAt)).toBeUndefined()
    expect(decisionReadinessContinuationDelayMs(waiting(reason), 30_000, instant(2_000))).toBe(5_000)
  },
)

test.each([DecisionReadinessReason.SnapshotUnavailable, DecisionReadinessReason.SnapshotStale])(
  '%s preserves the known next-window wake before the original unused entry expires',
  (reason) => {
    const prior = Schema.decodeUnknownSync(AutonomousCycleSchema)({
      ...cycle,
      createdAt: instant(-33_864),
      updatedAt: instant(-33_864),
    })
    const result = { ...waiting(reason, instant(4_471)), cycle: prior }
    expect(unusedEntryExpiresAt(prior)).toBe(observedMs + 26_136)
    expect(decisionReadinessContinuationDelayMs(result, 30_000, observedAt)).toBe(4_471)
    expect(hasExpiredUnusedEntryAdmission(prior, instant(30_000))).toBe(true)
    expect(hasExpiredUnusedEntryAdmission(prior, result.readiness.availableAt ?? '')).toBe(false)
    expect(decisionReadinessContinuationDelayMs(result, 30_000, instant(4_471))).toBeUndefined()
    for (const at of [instant(26_136), instant(26_137)])
      expect(
        decisionReadinessContinuationDelayMs(
          { ...result, readiness: { ...result.readiness, availableAt: at } },
          90_000,
          observedAt,
        ),
      ).toBeUndefined()
    for (const bindings of [{ snapshotId: 'a'.repeat(64) }, { decisionHash: 'b'.repeat(64) }])
      expect(
        decisionReadinessContinuationDelayMs({ ...result, cycle: { ...prior, bindings } }, 30_000, observedAt),
      ).toBeUndefined()
    for (const state of Object.values(CycleState).filter((s) => s !== CycleState.Active))
      expect(
        decisionReadinessContinuationDelayMs({ ...result, cycle: { ...prior, state } }, 30_000, observedAt),
      ).toBeUndefined()
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
      reason !== DecisionReadinessReason.SnapshotUnavailable &&
      reason !== DecisionReadinessReason.SnapshotStale &&
      reason !== DecisionReadinessReason.ExecutionRiskExpired &&
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

test('verified risk expiry refreshes only inside the unchanged unused entry deadline', () => {
  const result = {
    ...waiting(DecisionReadinessReason.InferenceExpired),
    readiness: {
      reason: DecisionReadinessReason.ExecutionRiskExpired as const,
      message: 'Risk expired during binding',
      riskClockRejection: {
        schemaVersion: 'bayn.intent-risk-clock-rejection.v1' as const,
        violation: 'EXPIRED' as const,
        intentId: 'a'.repeat(64),
        decisionId: 'b'.repeat(64),
        decidedAt: instant(0),
        updatedAt: instant(1),
        expiresAt: instant(1000),
        checkedAt: instant(2000),
      },
    },
  }
  expect(decisionReadinessContinuationDelayMs(result, 30_000, instant(2000))).toBe(1)
  const deadline = unusedEntryExpiresAt(cycle)
  for (const at of [deadline, deadline + 1])
    expect(decisionReadinessContinuationDelayMs(result, 30_000, new Date(at).toISOString())).toBeUndefined()
  for (const bindings of [{ snapshotId: 'a'.repeat(64) }, { decisionHash: 'b'.repeat(64) }])
    expect(
      decisionReadinessContinuationDelayMs({ ...result, cycle: { ...cycle, bindings } }, 30_000, instant(2000)),
    ).toBeUndefined()
})

const pendingInputs = (previousWindowEndAt?: string) => ({
  ...waiting(DecisionReadinessReason.SnapshotUnavailable),
  readiness: {
    reason: DecisionReadinessReason.SnapshotUnavailable as const,
    message: 'No candidate has complete raw data and a matching rolling feature',
    snapshotQuery: {
      rangeStartAt: native.query.rangeStartAt,
      rangeEndAt: native.query.rangeEndAt,
      symbols: native.query.symbols ?? native.query.universe,
      ...(previousWindowEndAt === undefined ? {} : { previousWindowEndAt }),
    },
  },
})

test.each([native.query.rangeEndAt, instant(60_000), 'invalid'])(
  'already consumed or inconsistent missing inputs keep the ordinary cadence (%s)',
  (previousWindowEndAt) => {
    const result = pendingInputs(previousWindowEndAt)
    expect(decisionReadinessContinuationDelayMs(result, 30_000, instant(37_171))).toBeUndefined()
  },
)

test.each([undefined, instant(-60_000)])(
  'rechecks initial or later snapshot inputs inside the original admission (%s)',
  (previousWindowEndAt) => {
    // The retained 16:24 cycle had 22,829 ms left when its next feature cut was unavailable.
    const checkedAt = instant(37_171)
    const result = pendingInputs(previousWindowEndAt)
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
  },
)

test('initial missing inputs recheck during a quote window that the ordinary poll misses', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // Retained 16:54 pass: first wait ended 2,466ms after issue; MU arrived at +17,380ms.
      const firstWaitMs = 2_466
      const quoteAvailableMs = 17_380
      const quoteExpiresMs = 25_904
      yield* TestClock.setTime(observedMs + firstWaitMs)
      const result = pendingInputs()
      let retries = 0
      while (Date.parse(yield* currentUtcInstant) < observedMs + quoteAvailableMs) {
        const delay = decisionReadinessContinuationDelayMs(result, 30_000, yield* currentUtcInstant)
        expect(delay).toBe(1_000)
        if (delay === undefined) return yield* Effect.die('Initial missing inputs require a bounded continuation')
        yield* TestClock.adjust(delay)
        retries += 1
      }
      const readyAt = Date.parse(yield* currentUtcInstant)
      expect(retries).toBe(15)
      expect(readyAt).toBeLessThan(observedMs + quoteExpiresMs)
      expect(observedMs + firstWaitMs + 30_000).toBeGreaterThan(observedMs + quoteExpiresMs)
      expect(hasExpiredUnusedEntryAdmission(cycle, yield* currentUtcInstant)).toBe(false)
      expect(unusedEntryExpiresAt(cycle)).toBe(observedMs + 60_000)
    }).pipe(Effect.provide(TestClock.layer())),
  )
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

test.each([
  DecisionReadinessReason.SignalWindowObserved,
  DecisionReadinessReason.SnapshotUnavailable,
  DecisionReadinessReason.SnapshotStale,
])('persists a %s boundary wake through the receipt and restart-safe controller chain', async (reason) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(observedMs)
      const result = waiting(reason)
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
