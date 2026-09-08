import { describe, expect, test } from 'bun:test'

import { Result, Schema } from 'effect'

import type { MarketCalendarObservation } from './broker/alpaca'
import {
  CycleState,
  isIntradayCycleDraft,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type IntradayAutonomousCycle,
} from './cycle'
import {
  bindCycleExecutionSession,
  ExecutionSessionBindingSchema,
  type BindCycleExecutionSessionInput,
  type ExecutionSessionBinding,
} from './execution-session'
import { canonicalHashV1 } from './hash'
import { strictParseOptions } from './schemas'
import { intradayMomentumExecutionModel } from './strategy/intraday-momentum/protocol'

const hash = (character: string): string => character.repeat(64)

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const calendar = (closeAt = '2026-02-02T21:00:00.000Z'): MarketCalendarObservation => {
  const material = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: { start: '2026-02-02', end: '2026-02-02' },
    timeZone: 'UTC' as const,
    sessions: [
      {
        date: '2026-02-02',
        openAt: '2026-02-02T14:30:00.000Z',
        closeAt,
      },
    ],
  }
  return { ...material, normalizedResponseHash: canonicalHashV1(material) }
}

const activeCycle = (): IntradayAutonomousCycle => {
  const session = calendar().sessions[0]
  if (session === undefined) throw new Error('test calendar requires one execution session')
  const observedCalendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      ...session,
    }),
  )
  const executionPolicy = value(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') {
    throw new Error('intraday execution must derive a v3 cycle policy')
  }
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId: hash('1'),
      strategyProtocolHash: hash('2'),
      accountId: 'account-1',
      executionSessionDate: observedCalendar.executionSessionDate,
      executionCalendarSchemaVersion: observedCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: observedCalendar.executionCalendarSource,
      executionCalendarHash: observedCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = value(makeIntradayCycleWindow(observedCalendar, executionPolicy))
  const draft = value(makeCycleDraft(identity, window))
  if (!isIntradayCycleDraft(draft)) throw new Error('intraday identity must construct an intraday cycle')
  return {
    ...draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: '2026-02-02T14:00:00.000Z',
    updatedAt: window.submissionOpenAt,
  }
}

const input = (overrides: Partial<BindCycleExecutionSessionInput> = {}): BindCycleExecutionSessionInput => {
  const cycle = activeCycle()
  return {
    cycle,
    executionSessionDate: cycle.identity.executionSessionDate,
    planningBrokerState: {
      observedAt: cycle.window.submissionOpenAt,
      contentHash: hash('3'),
    },
    calendar: calendar(),
    executionModel: intradayMomentumExecutionModel,
    ...overrides,
  }
}

const bind = (overrides: Partial<BindCycleExecutionSessionInput> = {}): ExecutionSessionBinding =>
  value(bindCycleExecutionSession(input(overrides)))

describe('intraday execution-session binding', () => {
  test('binds the exact session, warmup, cutoff, broker observation, and content hash', () => {
    const binding = bind()

    expect(binding).toMatchObject({
      schemaVersion: 'bayn.execution-session-binding.v3',
      executionSession: {
        date: '2026-02-02',
        openAt: '2026-02-02T14:30:00.000Z',
        closeAt: '2026-02-02T21:00:00.000Z',
      },
      submissionOpenAt: '2026-02-02T15:30:00.000Z',
      submissionCutoffAt: '2026-02-02T20:00:00.000Z',
      decisionAfterOpenMs: 3_600_000,
      submissionCutoffAfterOpenMs: 19_800_000,
    })
    expect(
      Schema.decodeUnknownSync(ExecutionSessionBindingSchema, strictParseOptions)(structuredClone(binding)),
    ).toEqual(binding)
  })

  test('allows reconciled broker state to narrow but never exhaust the submission window', () => {
    expect(
      bind({
        planningBrokerState: {
          observedAt: '2026-02-02T16:00:00.000Z',
          contentHash: hash('4'),
        },
      }).submissionOpenAt,
    ).toBe('2026-02-02T16:00:00.000Z')

    const exhausted = bindCycleExecutionSession(
      input({
        planningBrokerState: {
          observedAt: '2026-02-02T20:00:00.000Z',
          contentHash: hash('5'),
        },
      }),
    )
    expect(Result.isFailure(exhausted)).toBeTrue()
  })

  test('fails closed when the calendar or execution model diverges from the durable cycle', () => {
    const changedCalendar = bindCycleExecutionSession(input({ calendar: calendar('2026-02-02T18:00:00.000Z') }))
    expect(Result.isFailure(changedCalendar)).toBeTrue()
    if (Result.isFailure(changedCalendar)) {
      expect(changedCalendar.failure).toMatchObject({
        operation: 'bind-cycle',
        reason: 'cycle-calendar',
        facts: { field: 'executionCloseAt' },
      })
    }

    const changedModel = {
      ...intradayMomentumExecutionModel,
      order: {
        ...intradayMomentumExecutionModel.order,
        warmupAfterOpenMs: intradayMomentumExecutionModel.order.warmupAfterOpenMs + 60_000,
      },
    }
    const mismatchedModel = bindCycleExecutionSession(input({ executionModel: changedModel }))
    expect(Result.isFailure(mismatchedModel)).toBeTrue()
    if (Result.isFailure(mismatchedModel)) {
      expect(mismatchedModel.failure).toMatchObject({
        operation: 'bind-cycle',
        reason: 'cycle-policy',
        facts: { field: 'strategyExecutionModelHash' },
      })
    }
  })
})
