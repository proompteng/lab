import { expect, test } from 'bun:test'

import { CycleState, CycleTerminalReason } from './cycle'
import { CycleOperationsCondition, CycleOperationsReason } from './cycle/observability'
import { DecisionReadinessReason } from './cycle/runner/readiness'
import { ExecutionControllerOutcome } from './execution/controller-status'
import { Authority, KillState, ReconciliationStatus } from './execution/contracts'
import { executionSessionPreflightReady, renderPrometheusMetrics, statusResponseDecision } from './http'
import type { RuntimeState } from './runtime-state'
import { config, provenance, readyState } from './testing/runtime-fixtures'

const sessionState = (checkedAt = '2026-10-01T13:20:00.000Z'): RuntimeState => {
  const initial = readyState()
  const accountId = 'session-readiness-test'
  const planHash = 'f'.repeat(64)
  const pass = {
    result: 'SUCCESS',
    outcome: 'RECOVERED',
    recoveryAction: 'WAITING',
    waitReason: 'AWAITING_SUBMISSION_OPEN',
    observedAt: checkedAt,
  } as const
  return {
    ...initial,
    health: { ...initial.health, checkedAt },
    capitalActivation: {
      _tag: 'Realized',
      requestHash: 'a'.repeat(64),
      generationHash: 'b'.repeat(64),
      grant: 'Research',
      scope: 'Standing',
    },
    cycle: {
      ...initial.cycle,
      condition: CycleOperationsCondition.Waiting,
      reason: CycleOperationsReason.AwaitingSubmissionOpen,
      current: {
        cycleId: 'c'.repeat(64),
        accountId,
        signalSessionDate: '2026-10-01',
        executionSessionDate: '2026-10-01',
        phase: CycleState.Active,
        snapshotId: null,
        publicationDeadlineAt: null,
        decisionHash: null,
        terminalReason: null,
        submissionOpenAt: '2026-10-01T13:30:00.000Z',
        submissionCutoffAt: '2026-10-01T19:55:00.000Z',
        executionOpenAt: '2026-10-01T13:30:00.000Z',
        executionCloseAt: '2026-10-01T20:00:00.000Z',
        createdAt: '2026-09-30T19:55:30.000Z',
        updatedAt: '2026-09-30T19:55:30.000Z',
        terminalAt: null,
      },
      authority: {
        generationHash: 'b'.repeat(64),
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        reason: null,
        updatedAt: checkedAt,
      },
      reconciliation: {
        accountId,
        reconciliationId: 'd'.repeat(64),
        status: ReconciliationStatus.Exact,
        discrepancyCount: 0,
        reconciledAt: checkedAt,
        coversLatestMutation: true,
      },
      reconciliationCoversLatestMutation: true,
    },
    autonomousCycleLoop: { ...initial.autonomousCycleLoop, lastPass: pass },
    broker: {
      configured: true,
      expectedAccountId: accountId,
      accountId,
      accountBound: true,
      readAvailable: true,
      checkedAt,
      error: null,
      executionEligible: true,
      executionDisabledReason: null,
    },
    executionController: {
      configured: true,
      controllerKey: 'primary',
      planHash,
      readAvailable: true,
      checkedAt,
      error: null,
      status: {
        schemaVersion: 1,
        controllerKey: 'primary',
        planHash,
        active: true,
        epoch: 2,
        nextSequence: 3,
        lastSequence: 2,
        lastOutcome: ExecutionControllerOutcome.Waiting,
        lastReceiptHash: 'e'.repeat(64),
        completedAt: checkedAt,
        nextDueAt: new Date(Date.parse(checkedAt) + 30_000).toISOString(),
        lastPass: pass,
      },
    },
  }
}

const expectSession = (state: RuntimeState, condition: string, ready: boolean) =>
  expect(statusResponseDecision(state, config.execution, provenance, config.build.verification)).toMatchObject({
    body: {
      executionSession: {
        condition,
        ready,
        executionSessionDate: '2026-10-01',
        controllerPlanHash: 'f'.repeat(64),
        firstObservationAt: '2026-10-01T14:00:02.000Z',
        decisionDeadlineAt: '2026-10-01T14:01:02.000Z',
      },
    },
  })

test('pre-open execution prerequisites are ready before a snapshot or decision exists', () => {
  const state = sessionState()
  expect(executionSessionPreflightReady(state)).toBe(true)
  expectSession(state, 'PREOPEN', true)
  const metrics = renderPrometheusMetrics(state, config, provenance, config.build.verification)
  expect(metrics).toContain('bayn_execution_session_preflight_ready 1\n')
  expect(metrics).toContain('bayn_cycle_decision_bound 0\n')
  expect(metrics).toContain(
    `bayn_cycle_decision_deadline_timestamp_seconds ${Date.parse('2026-10-01T14:01:02Z') / 1000}\n`,
  )
})

test.each([
  ['2026-10-01T13:30:00.000Z', 'WARMUP', true],
  ['2026-10-01T14:00:01.999Z', 'WARMUP', true],
  ['2026-10-01T14:00:02.000Z', 'AWAITING_DECISION', true],
  ['2026-10-01T14:01:01.999Z', 'AWAITING_DECISION', true],
  ['2026-10-01T14:01:02.000Z', 'DECISION_LAGGING', false],
  ['2026-10-01T19:55:00.000Z', 'CLOSED', false],
] as const)('classifies the unbound session at %s as %s', (checkedAt, condition, ready) => {
  expectSession(sessionState(checkedAt), condition, ready)
})

test('a completed bootstrap cannot make a terminalized current session ready', () => {
  const state = sessionState('2026-10-01T14:00:30.000Z')
  const cycle = state.cycle.current
  const controller = state.executionController
  if (cycle === null || controller?.status === null || controller === undefined) throw new Error('fixture missing')
  const blocked: RuntimeState = {
    ...state,
    cycle: {
      ...state.cycle,
      current: null,
      last: { ...cycle, phase: CycleState.Blocked, terminalReason: CycleTerminalReason.ProvenanceMismatch },
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.LastCycleBlocked,
    },
    executionController: {
      ...controller,
      status: { ...controller.status, lastOutcome: ExecutionControllerOutcome.Blocked },
    },
  }
  expectSession(blocked, 'BLOCKED', false)
})

test('operator restriction remains recovery-only after a successful controller handoff', () => {
  const state = sessionState()
  const authority = state.cycle.authority
  if (authority === null) throw new Error('fixture authority missing')
  expectSession(
    {
      ...state,
      cycle: {
        ...state.cycle,
        authority: { ...authority, effective: Authority.Observe, kill: KillState.Active, reason: 'operator hold' },
      },
    },
    'RECOVERY_ONLY',
    false,
  )
})

test('ordinary no-trade completion remains a functioning session', () => {
  const state = sessionState('2026-10-01T14:00:30.000Z')
  const cycle = state.cycle.current
  if (cycle === null) throw new Error('fixture cycle missing')
  expectSession(
    {
      ...state,
      cycle: {
        ...state.cycle,
        current: null,
        last: { ...cycle, phase: CycleState.NoTrade },
        reason: CycleOperationsReason.LastCycleNoTrade,
      },
    },
    'ABSTAINING',
    true,
  )
})

test('missing signal input is distinct from a usable execution preflight', () => {
  const state = sessionState('2026-10-01T14:00:30.000Z')
  const unavailable: RuntimeState = {
    ...state,
    autonomousCycleLoop: {
      ...state.autonomousCycleLoop,
      lastPass: {
        result: 'SUCCESS',
        outcome: 'RECOVERED',
        recoveryAction: 'WAITING',
        observedAt: state.health.checkedAt ?? '',
        readiness: { reason: DecisionReadinessReason.SnapshotUnavailable, message: 'required benchmark missing' },
      },
    },
  }
  expect(executionSessionPreflightReady(unavailable)).toBe(true)
  expectSession(unavailable, 'INPUT_UNAVAILABLE', false)
})

test('a new intraday attempt gets its own bounded decision deadline', () => {
  const state = sessionState('2026-10-01T15:00:30.000Z')
  const cycle = state.cycle.current
  if (cycle === null) throw new Error('fixture cycle missing')
  expect(
    statusResponseDecision(
      {
        ...state,
        cycle: { ...state.cycle, current: { ...cycle, createdAt: '2026-10-01T15:00:00.000Z' } },
      },
      config.execution,
      provenance,
      config.build.verification,
    ),
  ).toMatchObject({
    body: {
      executionSession: { condition: 'AWAITING_DECISION', ready: true, decisionDeadlineAt: '2026-10-01T15:01:00.000Z' },
    },
  })
})

test('controller startup without a durable completion cannot establish session readiness', () => {
  const state = sessionState()
  const controller = state.executionController
  if (controller === undefined) throw new Error('fixture controller missing')
  expect(
    executionSessionPreflightReady({
      ...state,
      executionController: {
        ...controller,
        status: {
          schemaVersion: 1,
          controllerKey: controller.controllerKey,
          planHash: controller.planHash,
          active: true,
          epoch: 1,
          nextSequence: 1,
        },
      },
    }),
  ).toBe(false)
})

test('a healthy runtime with no eligible session does not imply session readiness', () => {
  const state = sessionState()
  expect(
    statusResponseDecision(
      { ...state, cycle: { ...state.cycle, current: null, last: null } },
      config.execution,
      provenance,
      config.build.verification,
    ),
  ).toMatchObject({
    body: {
      operational: { ready: true },
      executionSession: { condition: 'UNAVAILABLE', ready: false, executionSessionDate: null },
    },
  })
})

test('a controller running a different plan cannot establish session readiness', () => {
  const state = sessionState()
  const controller = state.executionController
  if (controller?.status === null || controller === undefined) throw new Error('fixture controller missing')
  const mismatched = {
    ...state,
    executionController: { ...controller, status: { ...controller.status, planHash: '9'.repeat(64) } },
  }
  expect(executionSessionPreflightReady(mismatched)).toBe(false)
  expectSession(mismatched, 'UNAVAILABLE', false)
})

test('a decision-bound position remains executable through the close window', () => {
  const state = sessionState('2026-10-01T19:55:00.000Z')
  const cycle = state.cycle.current
  if (cycle === null) throw new Error('fixture cycle missing')
  expectSession(
    {
      ...state,
      cycle: { ...state.cycle, current: { ...cycle, snapshotId: 'a'.repeat(64), decisionHash: 'b'.repeat(64) } },
    },
    'CLOSING',
    true,
  )
})

test('runtime freshness failure closes both session metrics', () => {
  const state = sessionState()
  const metrics = renderPrometheusMetrics(state, config, provenance, config.build.verification, false)
  expect(metrics).toContain('bayn_execution_session_ready 0\n')
  expect(metrics).toContain('bayn_execution_session_preflight_ready 0\n')
  expect(metrics).toContain('bayn_execution_session_condition{condition="unavailable"} 1\n')
})

test('no eligible candidate remains ordinary abstention after the decision deadline', () => {
  const state = sessionState('2026-10-01T15:00:00.000Z')
  const abstaining: RuntimeState = {
    ...state,
    autonomousCycleLoop: {
      ...state.autonomousCycleLoop,
      lastPass: {
        result: 'SUCCESS',
        outcome: 'RECOVERED',
        recoveryAction: 'WAITING',
        observedAt: '2026-10-01T15:00:00.000Z',
        readiness: { reason: DecisionReadinessReason.NoEligibleCandidate, message: 'no candidate admitted' },
      },
    },
  }
  expectSession(abstaining, 'ABSTAINING', true)
  const metrics = renderPrometheusMetrics(abstaining, config, provenance, config.build.verification)
  expect(metrics).toContain('bayn_execution_session_ready 1\n')
  expect(metrics).toContain('bayn_execution_session_condition{condition="decision_lagging"} 0\n')
})
