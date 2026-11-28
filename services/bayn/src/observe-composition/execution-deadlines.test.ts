import { expect, test } from 'bun:test'
import { Schema } from 'effect'

import { AutonomousCycleSchema, CycleState, CycleTerminalReason } from '../cycle/model'
import type { CycleRunResult } from '../cycle/runner/model'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { nativeJevFixture } from '../jev/native.test-support'
import type { RecoveryFirstCycleAdvance } from './model'
import { executionAdvanceDeadline, ExecutionDeadlineReason } from './recovery-driver'

const source = nativeJevFixture(undefined, '2026-09-04T14:56:54.802Z')
const observedAt = source.query.observedAt
const now = Date.parse(observedAt)
const at = (offset: number) => new Date(now + offset).toISOString()
const cycle = Schema.decodeUnknownSync(AutonomousCycleSchema)({
  ...source.draft,
  state: CycleState.Active,
  bindings: {},
  stateVersion: 1,
  createdAt: observedAt,
  updatedAt: observedAt,
})
const policy = { recoveryDelayMs: 30_000, financialFreshnessMs: 30_000, sessionCloseStartLeadMs: 5 * 60_000 }
const waiting = (
  reason: Exclude<
    DecisionReadinessReason,
    DecisionReadinessReason.ExecutionRiskExpired
  > = DecisionReadinessReason.SnapshotUnavailable,
): CycleRunResult => ({
  outcome: 'RECOVERED',
  action: 'WAITING',
  observedAt,
  cycle,
  readiness: { reason, message: 'Awaiting original source evidence' },
})
const advance = (result: CycleRunResult): RecoveryFirstCycleAdvance => ({
  observation: { result: 'SUCCESS', outcome: 'RECOVERED', observedAt },
  result,
})

test.each(['preflight', 'cycle'] as const)(
  '%s broker observation waits retain the existing post-mutation continuation deadline',
  (phase) => {
    const pending: RecoveryFirstCycleAdvance = {
      observation: {
        result: 'SUCCESS',
        outcome: 'WAITING',
        waitReason: 'BROKER_OBSERVATION_PENDING',
        observedAt,
      },
      ...(phase === 'preflight'
        ? {}
        : {
            result: {
              outcome: 'RECOVERED' as const,
              action: 'WAITING' as const,
              observedAt,
              cycle: { ...cycle, bindings: { snapshotId: 'a'.repeat(64), decisionHash: 'b'.repeat(64) } },
              waitReason: 'BROKER_OBSERVATION_PENDING',
            },
          }),
    }

    for (const [nextDelayMs, expectedDelayMs] of [
      [undefined, 30_000],
      [1_000, 1_000],
      [60_000, 30_000],
      [0, 1],
    ] as const) {
      expect(
        executionAdvanceDeadline(
          { ...pending, ...(nextDelayMs === undefined ? {} : { nextDelayMs }) },
          observedAt,
          policy,
        ),
      ).toEqual({ at: at(expectedDelayMs), reason: ExecutionDeadlineReason.FinancialFreshness })
    }
    expect(
      executionAdvanceDeadline({ ...pending, nextDelayMs: 1_000, nextWakeAt: at(500) }, observedAt, policy),
    ).toEqual({
      at: at(500),
      reason: ExecutionDeadlineReason.Recovery,
    })
  },
)

test('source and inference waits retain their original admission expiry without discovery polling', () => {
  for (const reason of [
    DecisionReadinessReason.SnapshotUnavailable,
    DecisionReadinessReason.SnapshotCoverage,
    DecisionReadinessReason.SnapshotStale,
    DecisionReadinessReason.ArchiveWatermark,
    DecisionReadinessReason.DecisionPending,
    DecisionReadinessReason.InferenceUnavailable,
    DecisionReadinessReason.NoEligibleCandidate,
  ] as const) {
    const pending = advance(waiting(reason))
    expect(executionAdvanceDeadline(pending, observedAt, policy)).toEqual({
      at: at(60_000),
      reason: ExecutionDeadlineReason.Expiry,
    })
    expect(executionAdvanceDeadline(pending, at(55_000), policy)).toEqual({
      at: at(60_000),
      reason: ExecutionDeadlineReason.Expiry,
    })
  }
})

test('the mandatory completed-window eligibility wake uses its original absolute boundary', () => {
  const pending = advance({
    outcome: 'RECOVERED',
    action: 'WAITING',
    cycle,
    observedAt,
    readiness: {
      reason: DecisionReadinessReason.SignalWindowObserved,
      message: 'The next completed window is eligible two seconds after close',
      availableAt: at(7_000),
    },
  })
  expect(executionAdvanceDeadline(pending, observedAt, policy)).toEqual({
    at: at(7_000),
    reason: ExecutionDeadlineReason.Eligibility,
  })
  expect(executionAdvanceDeadline(pending, at(6_999), policy)?.at).toBe(at(7_000))
})

test('a passed source boundary waits for the stream instead of repeating an eligibility timer', () => {
  const pending = advance({
    outcome: 'RECOVERED',
    action: 'WAITING',
    cycle,
    observedAt,
    readiness: {
      reason: DecisionReadinessReason.SignalWindowObserved,
      message: 'The completed source has not arrived',
      availableAt: at(7_000),
    },
  })
  expect(executionAdvanceDeadline(pending, at(8_000), policy)).toEqual({
    at: at(60_000),
    reason: ExecutionDeadlineReason.Expiry,
  })
})

test('protection and maximum hold keep making progress independently of pending inference', () => {
  const heldCycle = { ...cycle, bindings: { snapshotId: 'a'.repeat(64), decisionHash: 'b'.repeat(64) } }
  const pending = advance({
    outcome: 'RECOVERED',
    action: 'WAITING',
    cycle: heldCycle,
    observedAt,
    waitReason: 'JEV_POSITION_HELD',
    maximumHoldDueAt: at(7_000),
    maximumHoldEvaluatedAt: observedAt,
  })
  expect(executionAdvanceDeadline(pending, observedAt, policy)).toEqual({
    at: at(5_000),
    reason: ExecutionDeadlineReason.Protection,
  })
  expect(executionAdvanceDeadline(pending, at(6_000), policy)).toEqual({
    at: at(7_000),
    reason: ExecutionDeadlineReason.Protection,
  })
  expect(executionAdvanceDeadline(pending, at(8_000), policy)?.at).toBe(at(8_001))
})

test('unknown mutation consistency retains a bounded recovery timer', () => {
  const pending = advance({
    outcome: 'RECOVERED',
    action: 'WAITING',
    cycle: { ...cycle, bindings: { snapshotId: 'a'.repeat(64), decisionHash: 'b'.repeat(64) } },
    observedAt,
    waitReason: 'MUTATION_RECOVERY_BACKOFF',
  })
  expect(executionAdvanceDeadline(pending, observedAt, policy)).toEqual({
    at: at(30_000),
    reason: ExecutionDeadlineReason.UnknownMutation,
  })
})

test('ordinary terminal success does not schedule a successor tick', () => {
  for (const action of ['COMPLETED', 'NO_TRADE', 'BLOCKED'] as const) {
    const completed = advance({
      outcome: 'RECOVERED',
      action,
      cycle: { ...cycle, state: CycleState.Completed },
      observedAt,
    })

    expect(executionAdvanceDeadline(completed, observedAt, policy)).toBeUndefined()
  }
})

test('a deferred terminal successor wakes at its known source boundary without an unused lease or polling timer', () => {
  const terminal = { ...cycle, state: CycleState.Blocked, terminalReason: CycleTerminalReason.UnusedEntryExpired }
  const pending = advance({
    outcome: 'ALREADY_TERMINAL',
    cycle: terminal,
    observedAt,
    readiness: {
      reason: DecisionReadinessReason.SignalWindowObserved,
      message: 'The current entry window is already consumed',
      availableAt: at(67_000),
    },
  })
  expect(executionAdvanceDeadline(pending, observedAt, policy)).toEqual({
    at: at(67_000),
    reason: ExecutionDeadlineReason.Eligibility,
  })
  expect(executionAdvanceDeadline(pending, at(66_999), policy)?.at).toBe(at(67_000))
  expect(executionAdvanceDeadline(pending, at(68_000), policy)).toEqual({
    at: at(68_001),
    reason: ExecutionDeadlineReason.Eligibility,
  })
  expect(
    executionAdvanceDeadline(advance({ outcome: 'ALREADY_TERMINAL', cycle: terminal, observedAt }), observedAt, policy),
  ).toBeUndefined()
})

test('an expired unbound admission hands off once before the unchanged cutoff', () => {
  const expired = advance({
    outcome: 'RECOVERED',
    action: 'BLOCKED',
    cycle: { ...cycle, state: CycleState.Blocked, terminalReason: CycleTerminalReason.UnusedEntryExpired },
    observedAt: at(60_000),
  })
  expect(executionAdvanceDeadline(expired, at(60_000), policy)).toEqual({
    at: at(60_001),
    reason: ExecutionDeadlineReason.StateTransition,
  })
  expect(executionAdvanceDeadline(expired, cycle.window.submissionCutoffAt, policy)).toBeUndefined()
})
