import { describe, expect, test } from 'bun:test'

import { MonthEndCadenceCondition, MonthEndCadenceReason } from '../observability'
import { CycleState, type AutonomousCycle } from '../model'
import { CycleNotDueReason, type CyclePassObservation, type CycleRunResult } from './model'
import { cyclePassLogFacts, retainAutonomousCyclePassObservation } from './pass-decisions'

const observedAt = '2026-08-03T13:30:00.000Z'
const signalSessionDate = '2026-07-31'
const executionSessionDate = '2026-08-03'

const terminalCycle = (): AutonomousCycle =>
  ({
    schemaVersion: 'bayn.autonomous-cycle.v1',
    identity: {
      schemaVersion: 'bayn.autonomous-cycle-identity.v1',
      cycleId: 'c'.repeat(64),
      signalSessionDate,
      executionSessionDate,
    },
    window: { schemaVersion: 'bayn.autonomous-cycle-window.v1' },
    state: CycleState.Completed,
  }) as unknown as AutonomousCycle

const succeeded = (result: CycleRunResult): CyclePassObservation => ({
  outcome: 'SUCCEEDED',
  observedAt,
  result,
})

const acquired = (outcome: 'ACQUIRED' | 'REACQUIRED'): CycleRunResult =>
  ({
    outcome,
    signalSessionDate,
    executionSessionDate,
    observedAt,
    calendarResponseHash: 'a'.repeat(64),
    calendarReadContentHash: 'b'.repeat(64),
    receipt: { created: outcome === 'ACQUIRED' },
    readiness: {
      outcome: 'BOUND',
      observedAt,
      cycle: terminalCycle(),
      snapshotId: 'd'.repeat(64),
    },
  }) as CycleRunResult

describe('autonomous cycle pass observability', () => {
  test('projects the exact NOT_DUE cadence reason and bounded next eligibility into structured logs', () => {
    const facts = cyclePassLogFacts({
      outcome: 'SUCCEEDED',
      observedAt: '2026-07-31T13:00:00.000Z',
      result: {
        outcome: 'NOT_DUE',
        signalSessionDate: '2026-07-30',
        executionSessionDate: '2026-07-31',
        observedAt: '2026-07-31T12:59:59.000Z',
        calendarResponseHash: 'a'.repeat(64),
        calendarReadContentHash: 'b'.repeat(64),
      },
    })

    expect(facts).toEqual({
      level: 'INFO',
      message: 'Bayn autonomous cycle pass completed',
      annotations: {
        outcome: 'NOT_DUE',
        signalSessionDate: '2026-07-30',
        executionSessionDate: '2026-07-31',
        observedAt: '2026-07-31T12:59:59.000Z',
        calendarResponseHash: 'a'.repeat(64),
        calendarReadContentHash: 'b'.repeat(64),
        cycleCadence: 'MONTHLY',
        cadenceCondition: MonthEndCadenceCondition.ExpectedWait,
        cadenceReason: MonthEndCadenceReason.SignalAndExecutionSessionSameMonth,
        nextEligibilityStatus: 'UNKNOWN',
        nextEligibilityReason: MonthEndCadenceReason.FutureCalendarEvidenceUnavailable,
      },
    })
  })

  test('reports every-session execution without projecting month-end eligibility', () => {
    const observation = succeeded({
      outcome: 'NOT_DUE',
      reason: CycleNotDueReason.StaleExecutionBootstrap,
      signalSessionDate: '2026-07-30',
      executionSessionDate: '2026-07-31',
      observedAt,
      calendarResponseHash: 'a'.repeat(64),
      calendarReadContentHash: 'b'.repeat(64),
    })

    expect(cyclePassLogFacts(observation, 'EVERY_SESSION').annotations).toEqual({
      outcome: 'NOT_DUE',
      notDueReason: CycleNotDueReason.StaleExecutionBootstrap,
      signalSessionDate: '2026-07-30',
      executionSessionDate: '2026-07-31',
      observedAt,
      calendarResponseHash: 'a'.repeat(64),
      calendarReadContentHash: 'b'.repeat(64),
      cycleCadence: 'EVERY_SESSION',
    })
    expect(retainAutonomousCyclePassObservation(observation, 'EVERY_SESSION')).toMatchObject({
      result: 'SUCCESS',
      cadence: 'EVERY_SESSION',
      outcome: 'NOT_DUE',
    })
  })

  test('retains exact latest-pass cadence evidence for every observable month-end outcome', () => {
    const results: readonly CycleRunResult[] = [
      {
        outcome: 'NOT_DUE',
        signalSessionDate: '2026-07-30',
        executionSessionDate: '2026-07-31',
        observedAt,
        calendarResponseHash: 'a'.repeat(64),
        calendarReadContentHash: 'b'.repeat(64),
      },
      acquired('ACQUIRED'),
      acquired('REACQUIRED'),
      { outcome: 'RECOVERED', action: 'COMPLETED', observedAt, cycle: terminalCycle() },
      { outcome: 'ALREADY_TERMINAL', observedAt, cycle: terminalCycle() },
    ]

    for (const result of results) {
      const retained = retainAutonomousCyclePassObservation(succeeded(result))
      expect(retained).toMatchObject({ result: 'SUCCESS', observedAt, outcome: result.outcome })
      if (retained.result !== 'SUCCESS') throw new Error('successful pass was not retained as success')
      expect(retained.cadenceDecision).toMatchObject(
        result.outcome === 'NOT_DUE'
          ? {
              condition: MonthEndCadenceCondition.ExpectedWait,
              reason: MonthEndCadenceReason.SignalAndExecutionSessionSameMonth,
              signalSessionDate: '2026-07-30',
              executionSessionDate: '2026-07-31',
              nextEligibility: { status: 'UNKNOWN' },
            }
          : {
              condition: MonthEndCadenceCondition.Due,
              reason: MonthEndCadenceReason.SignalToExecutionMonthTransition,
              signalSessionDate,
              executionSessionDate,
              nextEligibility: { status: 'PROVEN', sessionDate: executionSessionDate },
            },
      )
    }
  })

  test('projects retained terminal-cycle cadence into settled outcome logs', () => {
    for (const result of [
      { outcome: 'RECOVERED', action: 'COMPLETED', observedAt, cycle: terminalCycle() },
      { outcome: 'ALREADY_TERMINAL', observedAt, cycle: terminalCycle() },
    ] as const satisfies readonly CycleRunResult[]) {
      expect(cyclePassLogFacts(succeeded(result)).annotations).toMatchObject({
        outcome: result.outcome,
        signalSessionDate,
        executionSessionDate,
        cadenceCondition: MonthEndCadenceCondition.Due,
        cadenceReason: MonthEndCadenceReason.SignalToExecutionMonthTransition,
        nextEligibilityStatus: 'PROVEN',
        nextEligibleSessionDate: executionSessionDate,
      })
    }
  })
})
