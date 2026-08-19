import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import {
  CycleOperationsCondition,
  CycleOperationsReason,
  MonthEndCadenceCondition,
  MonthEndCadenceReason,
  decideMonthEndCadenceEligibility,
  deriveCycleOperationsStatus,
  deriveCycleOperationsStatusResult,
  projectAutonomousCycleCadenceObservation,
  retainedAutonomousCycleCadenceDecision,
  renderCycleOperationsStatusFailure,
  type CycleOperationsProjection,
  type CycleOperationsSnapshot,
} from './observability'
import { CycleState, CycleTerminalReason } from './model'
import { CycleNotDueReason } from './runner/model'
import { projectResearchCapitalBootstrapWaiting } from '../health/decisions'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { Authority, KillState, ReconciliationStatus } from '../execution/contracts'

const now = '2026-07-20T12:00:00.000Z'
const thresholds = {
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
}

const snapshot = (phase: CycleState, overrides: Partial<CycleOperationsSnapshot> = {}): CycleOperationsSnapshot => ({
  cycleId: '1'.repeat(64),
  accountId: 'paper-account-1',
  signalSessionDate: '2026-07-17',
  executionSessionDate: '2026-07-20',
  phase,
  snapshotId: phase === CycleState.Pending ? null : '2'.repeat(64),
  decisionHash: phase === CycleState.Completed || phase === CycleState.NoTrade ? '3'.repeat(64) : null,
  terminalReason: phase === CycleState.Blocked ? CycleTerminalReason.DataStale : null,
  submissionOpenAt: '2026-07-20T11:30:00.000Z',
  submissionCutoffAt: '2026-07-20T12:30:00.000Z',
  executionOpenAt: '2026-07-20T12:32:00.000Z',
  executionCloseAt: '2026-07-20T20:00:00.000Z',
  createdAt: '2026-07-20T11:29:00.000Z',
  updatedAt: '2026-07-20T11:59:00.000Z',
  terminalAt:
    phase === CycleState.Completed || phase === CycleState.NoTrade || phase === CycleState.Blocked
      ? '2026-07-20T11:59:00.000Z'
      : null,
  ...overrides,
})

const projection = (overrides: Partial<CycleOperationsProjection> = {}): CycleOperationsProjection => ({
  current: null,
  last: null,
  unfinishedCycleCount: 0,
  authority: null,
  reconciliation: null,
  mutations: {
    eventCount: 0,
    recoveryFoundCount: 0,
    approvedIntentCount: 0,
    acknowledgedIntentCount: 0,
    unresolvedCount: 0,
    oldestUnresolvedAt: null,
    latestOccurredAt: null,
  },
  ...overrides,
})

describe('month-end cadence observability decisions', () => {
  test('classifies a same-month execution session as an exact expected wait', () => {
    expect(
      decideMonthEndCadenceEligibility({
        signalSessionDate: '2026-07-30',
        executionSessionDate: '2026-07-31',
      }),
    ).toEqual({
      schemaVersion: 'bayn.month-end-cadence-decision.v1',
      condition: MonthEndCadenceCondition.ExpectedWait,
      reason: MonthEndCadenceReason.SignalAndExecutionSessionSameMonth,
      signalSessionDate: '2026-07-30',
      executionSessionDate: '2026-07-31',
      nextEligibility: {
        status: 'UNKNOWN',
        reason: MonthEndCadenceReason.FutureCalendarEvidenceUnavailable,
      },
    })
  })

  test('classifies a month transition as due and proves the execution session', () => {
    expect(
      decideMonthEndCadenceEligibility({
        signalSessionDate: '2026-07-31',
        executionSessionDate: '2026-08-03',
      }),
    ).toEqual({
      schemaVersion: 'bayn.month-end-cadence-decision.v1',
      condition: MonthEndCadenceCondition.Due,
      reason: MonthEndCadenceReason.SignalToExecutionMonthTransition,
      signalSessionDate: '2026-07-31',
      executionSessionDate: '2026-08-03',
      nextEligibility: {
        status: 'PROVEN',
        sessionDate: '2026-08-03',
        basis: 'EXECUTION_SESSION_MONTH_TRANSITION',
      },
    })
  })

  test('uses authoritative session dates without guessing across holiday and weekend gaps', () => {
    const holidayGap = decideMonthEndCadenceEligibility({
      signalSessionDate: '2026-11-25',
      executionSessionDate: '2026-11-27',
    })
    const weekendTransition = decideMonthEndCadenceEligibility({
      signalSessionDate: '2026-01-30',
      executionSessionDate: '2026-02-02',
    })

    expect(holidayGap).toMatchObject({
      condition: MonthEndCadenceCondition.ExpectedWait,
      reason: MonthEndCadenceReason.SignalAndExecutionSessionSameMonth,
      nextEligibility: { status: 'UNKNOWN' },
    })
    expect(weekendTransition).toMatchObject({
      condition: MonthEndCadenceCondition.Due,
      reason: MonthEndCadenceReason.SignalToExecutionMonthTransition,
      nextEligibility: { status: 'PROVEN', sessionDate: '2026-02-02' },
    })
  })

  test('reports bounded unknown for malformed, incomplete, or non-forward calendar evidence', () => {
    for (const facts of [
      { signalSessionDate: '2026-07-30' },
      { signalSessionDate: '2026-02-30', executionSessionDate: '2026-03-02' },
      { signalSessionDate: '2026-07-31', executionSessionDate: '2026-07-30' },
    ]) {
      expect(decideMonthEndCadenceEligibility(facts)).toMatchObject({
        condition: MonthEndCadenceCondition.Unknown,
        reason: MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence,
        nextEligibility: {
          status: 'UNKNOWN',
          reason: MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence,
        },
      })
    }
  })

  test('distinguishes a fresh expected wait from a missed or stalled loop', () => {
    const common = {
      configured: true,
      lastPassResult: 'SUCCESS' as const,
      lastPassOutcome: 'NOT_DUE',
    }
    const fresh = projectAutonomousCycleCadenceObservation({ ...common, freshness: 'AVAILABLE' })
    const stalled = projectAutonomousCycleCadenceObservation({ ...common, freshness: 'STALE' })

    expect(fresh).toMatchObject({
      condition: MonthEndCadenceCondition.ExpectedWait,
      reason: MonthEndCadenceReason.MonthEndCadenceNotDue,
      nextEligibility: {
        status: 'UNKNOWN',
        reason: MonthEndCadenceReason.FutureCalendarEvidenceUnavailable,
      },
    })
    expect(stalled).toMatchObject({
      condition: MonthEndCadenceCondition.Stalled,
      reason: MonthEndCadenceReason.CyclePassStale,
      nextEligibility: { status: 'UNKNOWN' },
    })
  })

  test('does not describe every-session execution as month-end waiting', () => {
    const cadenceDecision = decideMonthEndCadenceEligibility({
      signalSessionDate: '2026-07-31',
      executionSessionDate: '2026-08-03',
    })
    const project = (freshness: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE') =>
      projectAutonomousCycleCadenceObservation({
        configured: true,
        lastPassResult: 'SUCCESS',
        lastPassOutcome: 'NOT_DUE',
        freshness,
        cadence: 'EVERY_SESSION',
        cadenceDecision,
      })

    expect(project('AVAILABLE')).toMatchObject({
      condition: MonthEndCadenceCondition.NotApplicable,
      reason: MonthEndCadenceReason.PassOutcomeNotApplicable,
    })
    expect(project('STALE')).toMatchObject({
      condition: MonthEndCadenceCondition.Stalled,
      reason: MonthEndCadenceReason.CyclePassStale,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: { status: 'UNKNOWN' },
    })
    expect(project('UNAVAILABLE')).toMatchObject({
      condition: MonthEndCadenceCondition.Unknown,
      reason: MonthEndCadenceReason.RunnerUnavailable,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: { status: 'UNKNOWN' },
    })
  })

  test('reports a configured first-pass startup hang as stalled after runner classification', () => {
    expect(
      projectAutonomousCycleCadenceObservation({
        configured: true,
        lastPassResult: null,
        lastPassOutcome: null,
        freshness: 'STALE',
      }),
    ).toEqual({
      schemaVersion: 'bayn.autonomous-cycle-cadence-observation.v1',
      condition: MonthEndCadenceCondition.Stalled,
      reason: MonthEndCadenceReason.CyclePassStale,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: {
        status: 'UNKNOWN',
        reason: MonthEndCadenceReason.FutureCalendarEvidenceUnavailable,
      },
    })
    expect(
      projectAutonomousCycleCadenceObservation({
        configured: true,
        lastPassResult: null,
        lastPassOutcome: null,
        freshness: 'UNAVAILABLE',
      }),
    ).toMatchObject({
      condition: MonthEndCadenceCondition.Unknown,
      reason: MonthEndCadenceReason.RunnerUnavailable,
    })
  })

  test('preserves a proven month-transition eligibility from retained durable cycle facts', () => {
    const cadenceDecision = decideMonthEndCadenceEligibility({
      signalSessionDate: '2026-07-31',
      executionSessionDate: '2026-08-03',
    })

    expect(
      projectAutonomousCycleCadenceObservation({
        configured: true,
        lastPassResult: 'SUCCESS',
        lastPassOutcome: 'ACQUIRED',
        freshness: 'AVAILABLE',
        cadenceDecision,
      }),
    ).toEqual({
      schemaVersion: 'bayn.autonomous-cycle-cadence-observation.v1',
      condition: MonthEndCadenceCondition.Due,
      reason: MonthEndCadenceReason.SignalToExecutionMonthTransition,
      signalSessionDate: '2026-07-31',
      executionSessionDate: '2026-08-03',
      nextEligibility: {
        status: 'PROVEN',
        sessionDate: '2026-08-03',
        basis: 'EXECUTION_SESSION_MONTH_TRANSITION',
      },
    })
  })

  test('recomputes retained latest-pass evidence instead of trusting projected condition fields', () => {
    expect(
      retainedAutonomousCycleCadenceDecision({
        result: 'SUCCESS',
        outcome: 'RECOVERED',
        cadenceDecision: {
          condition: MonthEndCadenceCondition.ExpectedWait,
          reason: MonthEndCadenceReason.SignalAndExecutionSessionSameMonth,
          signalSessionDate: '2026-07-31',
          executionSessionDate: '2026-08-03',
        },
      }),
    ).toEqual({
      schemaVersion: 'bayn.month-end-cadence-decision.v1',
      condition: MonthEndCadenceCondition.Due,
      reason: MonthEndCadenceReason.SignalToExecutionMonthTransition,
      signalSessionDate: '2026-07-31',
      executionSessionDate: '2026-08-03',
      nextEligibility: {
        status: 'PROVEN',
        sessionDate: '2026-08-03',
        basis: 'EXECUTION_SESSION_MONTH_TRANSITION',
      },
    })
    expect(retainedAutonomousCycleCadenceDecision({ result: 'SUCCESS', outcome: 'NO_PUBLICATION' })).toBeUndefined()
    expect(retainedAutonomousCycleCadenceDecision({ cadenceDecision: 'malformed' })).toMatchObject({
      condition: MonthEndCadenceCondition.Unknown,
      reason: MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence,
    })
  })
})

describe('autonomous cycle operations classification', () => {
  test('projects only an exact reconciled research bootstrap miss into a healthy wait', () => {
    const last = snapshot(CycleState.Blocked, {
      signalSessionDate: '2026-08-10',
      executionSessionDate: '2026-08-11',
      terminalReason: CycleTerminalReason.MissedPublication,
    })
    const authority = {
      generationHash: '4'.repeat(64),
      maximum: Authority.Execution,
      effective: Authority.Execution,
      kill: KillState.Clear,
      reason: null,
      updatedAt: now,
    } as const
    const reconciliation = {
      accountId: 'paper-account-1',
      reconciliationId: '5'.repeat(64),
      status: ReconciliationStatus.Exact,
      discrepancyCount: 0,
      reconciledAt: now,
      coversLatestMutation: true,
    } as const
    const failed = deriveCycleOperationsStatus(
      projection({ last, authority, reconciliation }),
      Date.parse(now),
      Authority.Execution,
      thresholds,
    )
    const matchingPass = {
      result: 'SUCCESS' as const,
      outcome: 'NOT_DUE' as const,
      notDueReason: CycleNotDueReason.StaleExecutionBootstrap,
      cadenceDecision: { signalSessionDate: '2026-08-10', executionSessionDate: '2026-08-11' },
    }

    expect(projectResearchCapitalBootstrapWaiting(failed, true, matchingPass)).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.StaleExecutionBootstrapSkipped,
      last: { phase: CycleState.Blocked, terminalReason: CycleTerminalReason.MissedPublication },
      alerts: { cycleFailed: false, reconciliationBlocked: false, killActive: false },
    })

    const missedSubmission = deriveCycleOperationsStatus(
      projection({
        last: { ...last, terminalReason: CycleTerminalReason.MissedSubmission },
        authority,
        reconciliation,
      }),
      Date.parse(now),
      Authority.Execution,
      thresholds,
    )
    const controllerPass = {
      schemaVersion: 1 as const,
      controllerKey: '6'.repeat(64),
      planHash: '7'.repeat(64),
      active: true,
      epoch: 3,
      nextSequence: 9,
      lastSequence: 8,
      lastOutcome: ExecutionControllerOutcome.Blocked,
      lastReceiptHash: '8'.repeat(64),
      completedAt: '2026-07-20T12:00:00.000Z',
      nextDueAt: '2026-07-20T12:01:00.000Z',
      lastPass: {
        result: 'SUCCESS' as const,
        observedAt: '2026-07-20T12:00:00.000Z',
        outcome: 'NOT_DUE' as const,
        cadence: 'EVERY_SESSION' as const,
        notDueReason: CycleNotDueReason.StaleExecutionBootstrap,
        cadenceDecision: { signalSessionDate: '2026-08-10', executionSessionDate: '2026-08-11' },
      },
    }
    expect(projectResearchCapitalBootstrapWaiting(missedSubmission, true, null, controllerPass)).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.ResearchCapitalBootstrapRecovered,
      last: { phase: CycleState.Blocked, terminalReason: CycleTerminalReason.MissedSubmission },
      alerts: { cycleFailed: false, reconciliationBlocked: false, killActive: false },
    })
    const { nextDueAt: _nextDueAt, ...controllerWithoutSchedule } = controllerPass
    const { lastPass: _lastPass, ...controllerWithoutPass } = controllerPass
    for (const invalidController of [
      { ...controllerPass, active: false },
      { ...controllerPass, lastOutcome: ExecutionControllerOutcome.Completed },
      { ...controllerPass, completedAt: last.terminalAt ?? '' },
      controllerWithoutSchedule,
      controllerWithoutPass,
      {
        ...controllerPass,
        lastPass: { ...controllerPass.lastPass, notDueReason: CycleNotDueReason.MonthEndCadence },
      },
    ]) {
      expect(projectResearchCapitalBootstrapWaiting(missedSubmission, true, null, invalidController)).toBe(
        missedSubmission,
      )
    }
    expect(projectResearchCapitalBootstrapWaiting(failed, false, matchingPass)).toBe(failed)
    expect(
      projectResearchCapitalBootstrapWaiting(failed, true, {
        ...matchingPass,
        cadenceDecision: { signalSessionDate: '2026-09-10', executionSessionDate: '2026-09-11' },
      }),
    ).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.StaleExecutionBootstrapSkipped,
      last: { signalSessionDate: '2026-08-10', executionSessionDate: '2026-08-11' },
    })
    expect(
      projectResearchCapitalBootstrapWaiting(failed, true, {
        ...matchingPass,
        notDueReason: CycleNotDueReason.MonthEndCadence,
      }),
    ).toBe(failed)
    expect(
      projectResearchCapitalBootstrapWaiting(failed, true, {
        ...matchingPass,
        cadenceDecision: { ...matchingPass.cadenceDecision, signalSessionDate: '2026-08-09' },
      }),
    ).toBe(failed)
    expect(
      projectResearchCapitalBootstrapWaiting(failed, true, {
        ...matchingPass,
        cadenceDecision: { signalSessionDate: '2026-09-10', executionSessionDate: '2026-08-11' },
      }),
    ).toBe(failed)

    const unsafe = deriveCycleOperationsStatus(
      projection({
        last,
        authority,
        reconciliation,
        mutations: {
          eventCount: 1,
          recoveryFoundCount: 0,
          approvedIntentCount: 0,
          acknowledgedIntentCount: 0,
          unresolvedCount: 1,
          oldestUnresolvedAt: now,
          latestOccurredAt: now,
        },
      }),
      Date.parse(now),
      Authority.Execution,
      thresholds,
    )
    expect(projectResearchCapitalBootstrapWaiting(unsafe, true, matchingPass)).toBe(unsafe)
    expect(unsafe).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.UnresolvedMutation,
      alerts: { cycleFailed: true },
    })
  })

  test('returns exact clock failures without defecting', () => {
    const notInteger = deriveCycleOperationsStatusResult(projection(), 0.5, Authority.Observe, thresholds)
    expect(notInteger).toEqual(
      Result.fail({
        _tag: 'CycleOperationsClockInvalid',
        nowMs: 0.5,
        cause: { _tag: 'UtcEpochMillisNotSafeInteger', epochMillis: 0.5 },
      }),
    )
    if (Result.isFailure(notInteger)) {
      expect(renderCycleOperationsStatusFailure(notInteger.failure)).toBe(
        'cycle operations clock must be a safe integer epoch millisecond: observed=0.5',
      )
    }

    const outOfRange = deriveCycleOperationsStatusResult(
      projection(),
      8_640_000_000_000_001,
      Authority.Observe,
      thresholds,
    )
    expect(outOfRange).toEqual(
      Result.fail({
        _tag: 'CycleOperationsClockInvalid',
        nowMs: 8_640_000_000_000_001,
        cause: { _tag: 'UtcEpochMillisOutOfRange', epochMillis: 8_640_000_000_000_001 },
      }),
    )
    if (Result.isFailure(outOfRange)) {
      expect(renderCycleOperationsStatusFailure(outOfRange.failure)).toBe(
        'cycle operations clock is outside the supported UTC range: observed=8640000000000001',
      )
    }
  })

  test('distinguishes expected publication waiting from exact deadline and attempt stalls', () => {
    const pending = snapshot(CycleState.Pending, {
      submissionOpenAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T11:00:00.000Z',
    })
    const waiting = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse('2026-07-20T11:59:59.999Z'),
      Authority.Observe,
      thresholds,
    )
    const missed = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse(pending.submissionOpenAt),
      Authority.Observe,
      thresholds,
    )
    const boundPending = snapshot(CycleState.Pending, {
      snapshotId: '2'.repeat(64),
      submissionOpenAt: '2026-07-20T11:55:00.000Z',
      updatedAt: '2026-07-20T11:55:00.000Z',
    })
    const stale = deriveCycleOperationsStatus(
      projection({ current: boundPending, unfinishedCycleCount: 1 }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )

    expect(waiting).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.AwaitingSignalPublication,
    })
    expect(missed).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.MissedPublicationDeadline,
      alerts: { cycleStalled: true },
    })
    expect(stale).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.AttemptStale,
      attemptAgeMs: 300_000,
    })
  })

  test('keeps snapshot-bound PENDING expected before submission opens', () => {
    const pending = snapshot(CycleState.Pending, {
      snapshotId: '2'.repeat(64),
      submissionOpenAt: '2026-07-20T12:05:00.000Z',
      submissionCutoffAt: '2026-07-20T12:30:00.000Z',
      updatedAt: '2026-07-20T11:00:00.000Z',
    })
    const beforeOpen = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )
    const atOpen = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse(pending.submissionOpenAt),
      Authority.Observe,
      thresholds,
    )

    expect(beforeOpen).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.AwaitingSubmissionOpen,
      attemptAgeMs: 3_600_000,
      alerts: { cycleStalled: false },
    })
    expect(atOpen).toMatchObject({
      condition: CycleOperationsCondition.Running,
      reason: CycleOperationsReason.AwaitingActivation,
      alerts: { cycleStalled: false },
    })
  })

  test('tracks ACTIVE decision liveness through its immutable submission and execution deadlines', () => {
    const active = snapshot(CycleState.Active, {
      submissionOpenAt: '2026-07-20T11:30:00.000Z',
      submissionCutoffAt: '2026-07-20T12:30:00.000Z',
      executionOpenAt: '2026-07-20T12:32:00.000Z',
      executionCloseAt: '2026-07-20T20:00:00.000Z',
      updatedAt: '2026-07-20T11:29:00.000Z',
    })
    const classify = (candidate: CycleOperationsSnapshot, observedAt: string) =>
      deriveCycleOperationsStatus(
        projection({ current: candidate, unfinishedCycleCount: 1 }),
        Date.parse(observedAt),
        Authority.Observe,
        thresholds,
      )

    expect(classify(active, '2026-07-20T11:29:59.999Z')).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.AwaitingSubmissionOpen,
      alerts: { cycleStalled: false },
    })
    expect(classify(active, active.submissionOpenAt)).toMatchObject({
      condition: CycleOperationsCondition.Running,
      reason: CycleOperationsReason.AwaitingDecision,
      alerts: { cycleStalled: false },
    })
    expect(classify(active, active.submissionCutoffAt)).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.MissedSubmissionCutoff,
      alerts: { cycleStalled: true },
    })
    expect(classify(active, active.executionCloseAt)).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.MissedSubmissionCutoff,
      alerts: { cycleStalled: true },
    })

    const preflightFailedAtCutoff = deriveCycleOperationsStatus(
      projection({
        current: active,
        unfinishedCycleCount: 1,
        authority: null,
        reconciliation: null,
      }),
      Date.parse(active.submissionCutoffAt),
      Authority.Execution,
      thresholds,
    )
    expect(preflightFailedAtCutoff).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.MissedSubmissionCutoff,
      alerts: { cycleStalled: true, authorityIncoherent: true, reconciliationBlocked: true },
    })

    const decisionBound = { ...active, decisionHash: '3'.repeat(64) }
    expect(classify(decisionBound, active.submissionCutoffAt)).toMatchObject({
      condition: CycleOperationsCondition.Running,
      reason: CycleOperationsReason.Active,
      alerts: { cycleStalled: false },
    })
    expect(classify(decisionBound, active.executionCloseAt)).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.MissedExecutionClose,
      alerts: { cycleStalled: true },
    })
  })

  test('raises missed-submission at the exact cutoff and clears only on a later terminal cycle', () => {
    const pending = snapshot(CycleState.Pending, {
      snapshotId: '2'.repeat(64),
      submissionOpenAt: '2026-07-20T11:30:00.000Z',
      submissionCutoffAt: now,
    })
    const missed = deriveCycleOperationsStatus(
      projection({ current: pending, unfinishedCycleCount: 1 }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )
    const recovered = deriveCycleOperationsStatus(
      projection({
        last: snapshot(CycleState.Completed, {
          updatedAt: '2026-07-20T12:00:01.000Z',
          terminalAt: '2026-07-20T12:00:01.000Z',
        }),
      }),
      Date.parse('2026-07-20T12:00:01.000Z'),
      Authority.Observe,
      thresholds,
    )

    expect(missed).toMatchObject({
      condition: CycleOperationsCondition.Stalled,
      reason: CycleOperationsReason.MissedSubmissionCutoff,
      alerts: { cycleStalled: true },
    })
    expect(recovered).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.LastCycleCompleted,
      alerts: { cycleStalled: false, cycleFailed: false },
    })
  })

  test('reports a current active successor while retaining the prior blocked terminal evidence', () => {
    const blocked = snapshot(CycleState.Blocked)
    const successor = snapshot(CycleState.Active, {
      cycleId: '4'.repeat(64),
      signalSessionDate: '2026-07-20',
      executionSessionDate: '2026-07-21',
      submissionOpenAt: '2026-07-21T12:45:00.000Z',
      submissionCutoffAt: '2026-07-21T13:15:00.000Z',
      executionOpenAt: '2026-07-21T13:30:00.000Z',
      executionCloseAt: '2026-07-21T20:00:00.000Z',
      decisionHash: '5'.repeat(64),
      updatedAt: '2026-07-21T13:30:00.000Z',
    })
    const recoveringProjection = projection({ current: successor, last: blocked, unfinishedCycleCount: 1 })
    const withoutSuccessor = deriveCycleOperationsStatus(
      projection({ last: blocked }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )
    const executionWithoutSuccessor = deriveCycleOperationsStatus(
      projection({
        last: blocked,
        authority: {
          generationHash: '5'.repeat(64),
          maximum: Authority.Execution,
          effective: Authority.Execution,
          kill: KillState.Clear,
          reason: null,
          updatedAt: now,
        },
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '6'.repeat(64),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          reconciledAt: now,
          coversLatestMutation: true,
        },
      }),
      Date.parse(now),
      Authority.Execution,
      thresholds,
    )
    const recovering = deriveCycleOperationsStatus(
      recoveringProjection,
      Date.parse('2026-07-21T14:00:00.000Z'),
      Authority.Observe,
      thresholds,
    )
    const unsafeRecovering = deriveCycleOperationsStatus(
      {
        ...recoveringProjection,
        mutations: {
          eventCount: 1,
          recoveryFoundCount: 0,
          approvedIntentCount: 0,
          acknowledgedIntentCount: 0,
          unresolvedCount: 1,
          oldestUnresolvedAt: '2026-07-21T13:59:00.000Z',
          latestOccurredAt: '2026-07-21T13:59:00.000Z',
        },
      },
      Date.parse('2026-07-21T14:00:00.000Z'),
      Authority.Observe,
      thresholds,
    )
    const recovered = deriveCycleOperationsStatus(
      projection({
        last: snapshot(CycleState.Completed, {
          cycleId: '4'.repeat(64),
          updatedAt: now,
          terminalAt: now,
        }),
      }),
      Date.parse(now),
      Authority.Observe,
      thresholds,
    )

    expect(withoutSuccessor).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.LastCycleBlocked,
      last: { phase: CycleState.Blocked, terminalReason: CycleTerminalReason.DataStale },
      alerts: { cycleFailed: false },
    })
    expect(executionWithoutSuccessor).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.LastCycleBlocked,
      last: { phase: CycleState.Blocked, terminalReason: CycleTerminalReason.DataStale },
      alerts: { cycleFailed: true, reconciliationBlocked: false, authorityIncoherent: false },
    })
    expect(recovering).toMatchObject({
      current: { phase: CycleState.Active, cycleId: '4'.repeat(64) },
      last: { phase: CycleState.Blocked, terminalReason: CycleTerminalReason.DataStale },
      condition: CycleOperationsCondition.Running,
      reason: CycleOperationsReason.Active,
      alerts: { cycleFailed: false, cycleStalled: false },
    })
    expect(unsafeRecovering).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.UnresolvedMutation,
      alerts: { cycleFailed: true },
    })
    expect(recovered).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.LastCycleCompleted,
      alerts: { cycleFailed: false, cycleStalled: false },
    })
  })

  test('keeps OBSERVE credential-free while PAPER requires coherent durable authority and reconciliation', () => {
    const observe = deriveCycleOperationsStatus(projection(), Date.parse(now), Authority.Observe, thresholds)
    const missingPaper = deriveCycleOperationsStatus(projection(), Date.parse(now), Authority.Execution, thresholds)
    const readyPaper = deriveCycleOperationsStatus(
      projection({
        authority: {
          generationHash: '4'.repeat(64),
          maximum: Authority.Execution,
          effective: Authority.Observe,
          kill: KillState.Clear,
          reason: null,
          updatedAt: now,
        },
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '5'.repeat(64),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          reconciledAt: now,
          coversLatestMutation: true,
        },
      }),
      Date.parse(now),
      Authority.Execution,
      thresholds,
    )

    expect(observe).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      authority: null,
    })
    expect(missingPaper).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.AuthorityMissing,
      alerts: { authorityIncoherent: true },
    })
    expect(readyPaper).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      authority: { generationHash: '4'.repeat(64) },
      alerts: { authorityIncoherent: false, reconciliationBlocked: false },
    })
  })

  test('fails unresolved mutation immediately and raises its stale alert at the exact threshold', () => {
    const unresolved = projection({
      mutations: {
        eventCount: 1,
        recoveryFoundCount: 0,
        approvedIntentCount: 0,
        acknowledgedIntentCount: 0,
        unresolvedCount: 1,
        oldestUnresolvedAt: '2026-07-20T11:55:00.000Z',
        latestOccurredAt: '2026-07-20T11:55:00.000Z',
      },
    })
    const before = deriveCycleOperationsStatus(
      unresolved,
      Date.parse('2026-07-20T11:59:59.999Z'),
      Authority.Observe,
      thresholds,
    )
    const atThreshold = deriveCycleOperationsStatus(unresolved, Date.parse(now), Authority.Observe, thresholds)

    expect(before).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.UnresolvedMutation,
      zeroMutation: false,
      alerts: { cycleFailed: true, unknownMutationStale: false },
    })
    expect(atThreshold).toMatchObject({
      oldestUnresolvedMutationAgeMs: 300_000,
      alerts: { unknownMutationStale: true },
    })

    const cleared = deriveCycleOperationsStatus(projection(), Date.parse(now), Authority.Observe, thresholds)
    expect(cleared).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      alerts: { cycleFailed: false, unknownMutationStale: false },
    })
  })

  test('injects and clears kill, discrepancy, stale-data, and provenance failures through canonical state', () => {
    const observeAuthority = {
      generationHash: '4'.repeat(64),
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
      reason: null,
      updatedAt: now,
    } as const
    const capitalGrant = {
      ...observeAuthority,
      maximum: Authority.Execution,
      effective: Authority.Execution,
    } as const
    const exactReconciliation = {
      accountId: 'paper-account-1',
      reconciliationId: '5'.repeat(64),
      status: ReconciliationStatus.Exact,
      discrepancyCount: 0,
      reconciledAt: now,
      coversLatestMutation: true,
    } as const
    const observeClear = projection({ authority: observeAuthority })
    const paperClear = projection({ authority: capitalGrant, reconciliation: exactReconciliation })
    const scenarios = [
      {
        name: 'kill',
        maximum: Authority.Observe,
        injected: projection({ authority: { ...observeAuthority, kill: KillState.Active, reason: 'operator kill' } }),
        cleared: observeClear,
        reason: CycleOperationsReason.KillActive,
        terminalReason: null,
      },
      {
        name: 'reconciliation discrepancy',
        maximum: Authority.Execution,
        injected: projection({
          authority: capitalGrant,
          reconciliation: {
            ...exactReconciliation,
            status: ReconciliationStatus.Discrepancy,
            discrepancyCount: 1,
          },
        }),
        cleared: paperClear,
        reason: CycleOperationsReason.ReconciliationDiscrepancy,
        terminalReason: null,
      },
      {
        name: 'stale data',
        maximum: Authority.Execution,
        injected: projection({
          last: snapshot(CycleState.Blocked, { terminalReason: CycleTerminalReason.DataStale }),
          authority: capitalGrant,
          reconciliation: exactReconciliation,
        }),
        cleared: projection({
          last: snapshot(CycleState.Completed),
          authority: capitalGrant,
          reconciliation: exactReconciliation,
        }),
        reason: CycleOperationsReason.LastCycleBlocked,
        terminalReason: CycleTerminalReason.DataStale,
      },
      {
        name: 'provenance mismatch',
        maximum: Authority.Execution,
        injected: projection({
          last: snapshot(CycleState.Blocked, { terminalReason: CycleTerminalReason.ProvenanceMismatch }),
          authority: capitalGrant,
          reconciliation: exactReconciliation,
        }),
        cleared: projection({
          last: snapshot(CycleState.Completed),
          authority: capitalGrant,
          reconciliation: exactReconciliation,
        }),
        reason: CycleOperationsReason.LastCycleBlocked,
        terminalReason: CycleTerminalReason.ProvenanceMismatch,
      },
    ] as const

    for (const scenario of scenarios) {
      const injected = deriveCycleOperationsStatus(scenario.injected, Date.parse(now), scenario.maximum, thresholds)
      const cleared = deriveCycleOperationsStatus(scenario.cleared, Date.parse(now), scenario.maximum, thresholds)

      expect(injected.condition, scenario.name).toBe(CycleOperationsCondition.Failed)
      expect(injected.reason, scenario.name).toBe(scenario.reason)
      expect(injected.alerts.cycleFailed, scenario.name).toBe(true)
      expect(injected.last?.terminalReason ?? null, scenario.name).toBe(scenario.terminalReason)
      expect(cleared.condition, scenario.name).toBe(CycleOperationsCondition.Waiting)
      expect(cleared.alerts.cycleFailed, scenario.name).toBe(false)
    }
  })

  test('requires PAPER reconciliation to cover the latest selected-account mutation', () => {
    const authority = {
      generationHash: '4'.repeat(64),
      maximum: Authority.Execution,
      effective: Authority.Execution,
      kill: KillState.Clear,
      reason: null,
      updatedAt: now,
    } as const
    const latestOccurredAt = '2026-07-20T11:59:00.000Z'
    const input = (coversLatestMutation: boolean) =>
      projection({
        authority,
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '8'.repeat(64),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          reconciledAt: latestOccurredAt,
          coversLatestMutation,
        },
        mutations: {
          eventCount: 2,
          recoveryFoundCount: 0,
          approvedIntentCount: 0,
          acknowledgedIntentCount: 0,
          unresolvedCount: 0,
          oldestUnresolvedAt: null,
          latestOccurredAt,
        },
      })
    const covered = deriveCycleOperationsStatus(input(true), Date.parse(now), Authority.Execution, thresholds)
    const predates = deriveCycleOperationsStatus(input(false), Date.parse(now), Authority.Execution, thresholds)

    expect(covered).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      reconciliationCoversLatestMutation: true,
      alerts: { reconciliationBlocked: false },
    })
    expect(predates).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.ReconciliationPredatesMutation,
      reconciliationCoversLatestMutation: false,
      alerts: { reconciliationBlocked: true },
    })
  })

  test('blocks PAPER on discrepancy and exact reconciliation staleness boundaries', () => {
    const authority = {
      generationHash: '4'.repeat(64),
      maximum: Authority.Execution,
      effective: Authority.Execution,
      kill: KillState.Clear,
      reason: null,
      updatedAt: now,
    } as const
    const discrepancy = deriveCycleOperationsStatus(
      projection({
        authority,
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '6'.repeat(64),
          status: ReconciliationStatus.Discrepancy,
          discrepancyCount: 1,
          reconciledAt: now,
          coversLatestMutation: true,
        },
      }),
      Date.parse(now),
      Authority.Execution,
      thresholds,
    )
    const stale = deriveCycleOperationsStatus(
      projection({
        authority,
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '7'.repeat(64),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          reconciledAt: '2026-07-20T11:58:00.000Z',
          coversLatestMutation: true,
        },
      }),
      Date.parse(now),
      Authority.Execution,
      thresholds,
    )

    expect(discrepancy).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.ReconciliationDiscrepancy,
      alerts: { reconciliationBlocked: true },
    })
    expect(stale).toMatchObject({
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.ReconciliationStale,
      reconciliationAgeMs: 120_000,
      alerts: { reconciliationBlocked: true },
    })

    const cleared = deriveCycleOperationsStatus(
      projection({
        authority,
        reconciliation: {
          accountId: 'paper-account-1',
          reconciliationId: '8'.repeat(64),
          status: ReconciliationStatus.Exact,
          discrepancyCount: 0,
          reconciledAt: now,
          coversLatestMutation: true,
        },
      }),
      Date.parse(now),
      Authority.Execution,
      thresholds,
    )
    expect(cleared).toMatchObject({
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.NoCycleRecorded,
      alerts: { cycleFailed: false, reconciliationBlocked: false },
    })
  })
})
