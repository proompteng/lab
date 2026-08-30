import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import {
  CycleState,
  CycleTerminalReason,
  isIntradayCycleDraft,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type IntradayAutonomousCycle,
} from './index'
import { selectCycleRecovery, type CycleRecoveryState } from './recovery'
import { intradayMomentumExecutionModel } from '../strategy/intraday-momentum/protocol'

const hash = (character: string): string => character.repeat(64)
const cycleBindingId = hash('1')
const strategyProtocolHash = hash('2')
const accountId = 'sandbox-account'

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const pendingCycle = (): IntradayAutonomousCycle => {
  const calendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: '2026-02-02',
      openAt: '2026-02-02T14:30:00.000Z',
      closeAt: '2026-02-02T21:00:00.000Z',
    }),
  )
  const executionPolicy = value(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId: cycleBindingId,
      strategyProtocolHash,
      accountId,
      executionSessionDate: calendar.executionSessionDate,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const draft = value(makeCycleDraft(identity, value(makeIntradayCycleWindow(calendar, executionPolicy))))
  if (!isIntradayCycleDraft(draft)) throw new Error('expected an intraday cycle')
  return {
    ...draft,
    state: CycleState.Pending,
    bindings: {},
    stateVersion: 1,
    createdAt: '2026-02-02T14:29:00.000Z',
    updatedAt: '2026-02-02T14:29:00.000Z',
  }
}

const activeCycle = (bindings: IntradayAutonomousCycle['bindings'] = {}): IntradayAutonomousCycle => ({
  ...pendingCycle(),
  state: CycleState.Active,
  bindings,
  stateVersion: 2,
  updatedAt: '2026-02-02T14:30:00.000Z',
})

const recoveryState = (
  cycle: IntradayAutonomousCycle | undefined,
  overrides: Partial<CycleRecoveryState> = {},
): CycleRecoveryState => ({
  cycleBindingId,
  accountId,
  strategyProtocolHash,
  observedAt: '2026-02-02T16:00:00.000Z',
  cycle,
  ...overrides,
})

describe('intraday cycle recovery', () => {
  test('discovers work when no unfinished cycle exists', () => {
    expect(value(selectCycleRecovery(recoveryState(undefined)))).toEqual({ action: 'DISCOVER' })
  })

  test('activates a pending cycle, then waits through warmup before building a decision', () => {
    const pending = pendingCycle()
    expect(
      value(
        selectCycleRecovery(
          recoveryState(pending, {
            observedAt: '2026-02-02T14:45:00.000Z',
          }),
        ),
      ),
    ).toEqual({
      action: 'ACTIVATE',
      cycleId: pending.identity.cycleId,
      observedAt: '2026-02-02T14:45:00.000Z',
    })

    const active = activeCycle()
    expect(
      value(
        selectCycleRecovery(
          recoveryState(active, {
            observedAt: '2026-02-02T15:00:00.000Z',
          }),
        ),
      ),
    ).toEqual({ action: 'WAIT', cycle: active, observedAt: '2026-02-02T15:00:00.000Z' })

    expect(value(selectCycleRecovery(recoveryState(active)))).toEqual({ action: 'BUILD_DECISION', cycle: active })
  })

  test('reads a durable decision for a decision-bound cycle', () => {
    const cycle = activeCycle({ snapshotId: hash('3'), decisionHash: hash('4') })

    expect(value(selectCycleRecovery(recoveryState(cycle)))).toEqual({ action: 'READ_DECISION', cycle })
  })

  test('blocks cycles that reach cutoff or diverge from the active strategy protocol', () => {
    const cycle = activeCycle()
    expect(
      value(
        selectCycleRecovery(
          recoveryState(cycle, {
            observedAt: cycle.window.submissionCutoffAt,
          }),
        ),
      ),
    ).toEqual({
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt: cycle.window.submissionCutoffAt,
      reason: CycleTerminalReason.MissedSubmission,
    })

    expect(
      value(
        selectCycleRecovery(
          recoveryState(cycle, {
            strategyProtocolHash: hash('9'),
          }),
        ),
      ),
    ).toEqual({
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt: '2026-02-02T16:00:00.000Z',
      reason: CycleTerminalReason.ProvenanceMismatch,
    })
  })

  test('fails closed on scope and chronology mismatches', () => {
    const cycle = activeCycle()
    const wrongScope = selectCycleRecovery(recoveryState(cycle, { accountId: 'different-account' }))
    expect(Result.isFailure(wrongScope)).toBeTrue()
    if (Result.isFailure(wrongScope)) {
      expect(wrongScope.failure).toMatchObject({ operation: 'select', reason: 'scope' })
    }

    const staleObservation = selectCycleRecovery(recoveryState(cycle, { observedAt: '2026-02-02T14:29:59.999Z' }))
    expect(Result.isFailure(staleObservation)).toBeTrue()
    if (Result.isFailure(staleObservation)) {
      expect(staleObservation.failure).toMatchObject({ operation: 'select', reason: 'chronology' })
    }
  })

  test('rejects terminal cycles instead of replaying them', () => {
    const active = activeCycle({ snapshotId: hash('3'), decisionHash: hash('4') })
    const terminal = {
      ...active,
      state: CycleState.NoTrade,
      terminalAt: '2026-02-02T16:00:00.000Z',
      stateVersion: 3,
      updatedAt: '2026-02-02T16:00:00.000Z',
    }
    const result = selectCycleRecovery({
      ...recoveryState(undefined),
      cycle: terminal,
      observedAt: '2026-02-02T16:01:00.000Z',
    })

    expect(Result.isFailure(result)).toBeTrue()
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ operation: 'select', reason: 'terminal-cycle' })
    }
  })
})
