import { describe, expect, test } from 'bun:test'

import { Result, Schema } from 'effect'

import type { MarketCalendarObservation } from './broker/alpaca'
import {
  CycleState,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeIntradayCycleWindow,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  isIntradayCycleDraft,
  isLegacyCycleDraft,
  type CycleExecutionPolicy,
  type IntradayAutonomousCycle,
  type LegacyAutonomousCycle,
} from './cycle'
import { defaultExecutionModel } from './execution-model'
import {
  bindCycleExecutionSession,
  bindExecutionSession,
  ExecutionSessionBindingSchema,
  type BindCycleExecutionSessionInput,
  type BindExecutionSessionInput,
  type BindLegacyExecutionSessionInput,
  type ExecutionSessionBinding,
} from './execution-session'
import { canonicalHashV1 } from './hash'
import { strictParseOptions } from './schemas'
import { openingDriveExecutionModel } from './strategy/opening-drive'
import { intradayMomentumExecutionModel } from './strategy/intraday-momentum/protocol'

const hash = (character: string): string => character.repeat(64)
const resultValue = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}
type LegacyExecutionSessionBinding = Extract<
  ExecutionSessionBinding,
  { readonly schemaVersion: 'bayn.execution-session-binding.v1' }
>
type LegacyBindCycleExecutionSessionInput = BindLegacyExecutionSessionInput & {
  readonly cycle: LegacyAutonomousCycle
}

const bindExecutionSessionSuccess = (input: BindExecutionSessionInput): ExecutionSessionBinding =>
  resultValue(bindExecutionSession(input))
const bindCycleExecutionSessionSuccess = (input: BindCycleExecutionSessionInput): ExecutionSessionBinding =>
  resultValue(bindCycleExecutionSession(input))

const causalExecutionModel = (() => {
  if (defaultExecutionModel.schemaVersion !== 'bayn.execution-model.v3') {
    throw new Error('execution-session cycle fixtures require the account-neutral v3 execution model')
  }
  return defaultExecutionModel
})()

const calendar = (
  sessions: MarketCalendarObservation['sessions'],
  requestedRange = { start: '2026-07-02', end: '2026-07-10' },
): MarketCalendarObservation => {
  const material = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    requestedRange,
    timeZone: 'UTC',
    sessions,
  } as const
  return { ...material, normalizedResponseHash: canonicalHashV1(material) }
}

const bindingInput = (observation: MarketCalendarObservation): BindLegacyExecutionSessionInput => ({
  signal: {
    sessionDate: '2026-07-02',
    finalizedAt: '2026-07-02T22:00:00.000Z',
    contentHash: hash('a'),
  },
  planningBrokerState: {
    observedAt: '2026-07-02T22:01:00.000Z',
    contentHash: hash('b'),
  },
  calendar: observation,
  executionModel: defaultExecutionModel,
})

const bind = (observation: MarketCalendarObservation): LegacyExecutionSessionBinding => {
  const binding = bindExecutionSessionSuccess(bindingInput(observation))
  if (binding.schemaVersion !== 'bayn.execution-session-binding.v1') {
    throw new Error('legacy execution-session fixture returned an intraday binding')
  }
  return binding
}

const decodeBinding = Schema.decodeUnknownSync(ExecutionSessionBindingSchema, strictParseOptions)

const monthEndCalendar = calendar(
  [
    {
      date: '2026-01-30',
      openAt: '2026-01-30T14:30:00.000Z',
      closeAt: '2026-01-30T21:00:00.000Z',
    },
    {
      date: '2026-02-02',
      openAt: '2026-02-02T14:30:00.000Z',
      closeAt: '2026-02-02T21:00:00.000Z',
    },
    {
      date: '2026-02-03',
      openAt: '2026-02-03T14:30:00.000Z',
      closeAt: '2026-02-03T21:00:00.000Z',
    },
  ],
  { start: '2026-01-30', end: '2026-02-03' },
)

const makeActiveCycle = (policyOverride?: CycleExecutionPolicy): LegacyAutonomousCycle => {
  const executionSession = monthEndCalendar.sessions[1]
  if (executionSession === undefined) throw new Error('cycle fixture requires the first post-signal session')
  const executionCalendar = resultValue(
    makeExecutionCalendarObservation({
      schemaVersion: monthEndCalendar.schemaVersion,
      source: monthEndCalendar.source,
      ...executionSession,
    }),
  )
  const executionPolicy = policyOverride ?? resultValue(makeCycleExecutionPolicyFromModel(causalExecutionModel))
  const identity = resultValue(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v1',
      strategyName: 'risk-balanced-trend',
      qualificationRunId: hash('1'),
      strategyProtocolHash: hash('2'),
      accountId: 'paper-account-1',
      signalSessionDate: '2026-01-30',
      signalCalendarVersion: 'signal-calendar-v1',
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = resultValue(
    makeCycleWindow(
      {
        calendar_version: 'signal-calendar-v1',
        session_date: '2026-01-30',
        close_time: '16:00',
        timezone: 'America/New_York',
      },
      executionCalendar,
      executionPolicy,
    ),
  )
  const draft = resultValue(makeCycleDraft(identity, window))
  if (!isLegacyCycleDraft(draft)) throw new Error('legacy execution-session fixture returned an intraday draft')
  return {
    ...draft,
    state: CycleState.Active,
    bindings: { snapshotId: hash('3') },
    stateVersion: 3,
    createdAt: '2026-01-30T21:15:00.000Z',
    updatedAt: window.submissionOpenAt,
  }
}

const makeActiveOpeningCycle = (policyOverride?: CycleExecutionPolicy): IntradayAutonomousCycle => {
  const executionSession = monthEndCalendar.sessions[1]
  if (executionSession === undefined) throw new Error('opening cycle fixture requires the post-signal session')
  const executionCalendar = resultValue(
    makeExecutionCalendarObservation({
      schemaVersion: monthEndCalendar.schemaVersion,
      source: monthEndCalendar.source,
      ...executionSession,
    }),
  )
  const executionPolicy = policyOverride ?? resultValue(makeCycleExecutionPolicyFromModel(openingDriveExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v2') {
    throw new Error('opening cycle fixture requires the post-open execution policy')
  }
  const identity = resultValue(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'opening-drive-momentum',
      qualificationRunId: hash('4'),
      strategyProtocolHash: hash('5'),
      accountId: 'paper-account-1',
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = resultValue(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = resultValue(makeCycleDraft(identity, window))
  if (!isIntradayCycleDraft(draft)) throw new Error('intraday execution-session fixture returned a legacy draft')
  return {
    ...draft,
    state: CycleState.Active,
    bindings: { snapshotId: hash('6') },
    stateVersion: 3,
    createdAt: '2026-01-30T21:00:00.000Z',
    updatedAt: window.submissionOpenAt,
  }
}

const makeActiveIntradayMomentumCycle = (policyOverride?: CycleExecutionPolicy): IntradayAutonomousCycle => {
  const executionSession = monthEndCalendar.sessions[1]
  if (executionSession === undefined) throw new Error('intraday cycle fixture requires the post-signal session')
  const executionCalendar = resultValue(
    makeExecutionCalendarObservation({
      schemaVersion: monthEndCalendar.schemaVersion,
      source: monthEndCalendar.source,
      ...executionSession,
    }),
  )
  const executionPolicy =
    policyOverride ?? resultValue(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') {
    throw new Error('intraday momentum fixture requires the session-relative execution policy')
  }
  const identity = resultValue(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId: hash('7'),
      strategyProtocolHash: hash('8'),
      accountId: 'paper-account-1',
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = resultValue(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = resultValue(makeCycleDraft(identity, window))
  if (!isIntradayCycleDraft(draft)) throw new Error('intraday momentum fixture returned a legacy draft')
  return {
    ...draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: '2026-02-02T14:00:00.000Z',
    updatedAt: window.submissionOpenAt,
  }
}

const cycleBindingInput = (
  overrides: Partial<LegacyBindCycleExecutionSessionInput> = {},
): LegacyBindCycleExecutionSessionInput => {
  const cycle = makeActiveCycle()
  return {
    cycle,
    signal: {
      sessionDate: cycle.identity.signalSessionDate,
      finalizedAt: '2026-01-30T21:15:00.000Z',
      contentHash: hash('a'),
    },
    planningBrokerState: {
      observedAt: cycle.window.submissionOpenAt,
      contentHash: hash('b'),
    },
    calendar: monthEndCalendar,
    executionModel: causalExecutionModel,
    ...overrides,
  }
}

const bindCycle = (overrides: Partial<LegacyBindCycleExecutionSessionInput> = {}): LegacyExecutionSessionBinding => {
  const binding = bindCycleExecutionSessionSuccess(cycleBindingInput(overrides))
  if (binding.schemaVersion !== 'bayn.execution-session-binding.v1') {
    throw new Error('legacy cycle execution-session fixture returned an intraday binding')
  }
  return binding
}

describe('causal execution-session binding', () => {
  test('binds a holiday gap, fixed pre-open cutoff, and early close without assuming session hours', () => {
    const result = bind(
      calendar([
        {
          date: '2026-07-06',
          openAt: '2026-07-06T13:30:00.000Z',
          closeAt: '2026-07-06T17:00:00.000Z',
        },
        {
          date: '2026-07-07',
          openAt: '2026-07-07T13:30:00.000Z',
          closeAt: '2026-07-07T20:00:00.000Z',
        },
      ]),
    )

    expect(result).toMatchObject({
      schemaVersion: 'bayn.execution-session-binding.v1',
      executionSession: {
        date: '2026-07-06',
        openAt: '2026-07-06T13:30:00.000Z',
        closeAt: '2026-07-06T17:00:00.000Z',
      },
      submissionOpenAt: '2026-07-02T22:01:00.000Z',
      submissionCutoffAt: '2026-07-06T13:15:00.000Z',
      submissionCutoffLeadMinutes: 15,
    })
    expect(result.bindingHash).toBe('045ffeda9fa49a32f5552e648d954438572dcd1405539f132e7f77dc2b58ce21')
  })

  test('preserves the DST-normalized open supplied by the bounded broker observation', () => {
    const result = bindExecutionSessionSuccess({
      signal: {
        sessionDate: '2026-03-06',
        finalizedAt: '2026-03-06T22:00:00.000Z',
        contentHash: hash('c'),
      },
      planningBrokerState: {
        observedAt: '2026-03-06T22:01:00.000Z',
        contentHash: hash('d'),
      },
      calendar: calendar(
        [{ date: '2026-03-09', openAt: '2026-03-09T13:30:00.000Z', closeAt: '2026-03-09T20:00:00.000Z' }],
        { start: '2026-03-06', end: '2026-03-10' },
      ),
      executionModel: defaultExecutionModel,
    })

    expect(result.submissionCutoffAt).toBe('2026-03-09T13:15:00.000Z')
  })

  test('fails closed on calendar hash drift and a planning window that opens at the cutoff', () => {
    const observation = calendar([
      { date: '2026-07-06', openAt: '2026-07-06T13:30:00.000Z', closeAt: '2026-07-06T20:00:00.000Z' },
    ])
    expect(() =>
      bind({
        ...observation,
        sessions: [{ ...observation.sessions[0], closeAt: '2026-07-06T19:00:00.000Z' }],
      }),
    ).toThrow('normalized response hash')

    expect(() =>
      bindExecutionSessionSuccess({
        signal: {
          sessionDate: '2026-07-02',
          finalizedAt: '2026-07-06T13:15:00.000Z',
          contentHash: hash('e'),
        },
        planningBrokerState: {
          observedAt: '2026-07-06T13:14:59.999Z',
          contentHash: hash('f'),
        },
        calendar: observation,
        executionModel: defaultExecutionModel,
      }),
    ).toThrow('submissionOpenAt < submissionCutoffAt < executionSession.openAt')
  })

  test('requires signal finalization no earlier than the declared signal session date', () => {
    const observation = calendar([
      { date: '2026-07-06', openAt: '2026-07-06T13:30:00.000Z', closeAt: '2026-07-06T20:00:00.000Z' },
    ])
    const atBoundary = bindingInput(observation)
    const accepted = bindExecutionSession({
      ...atBoundary,
      signal: { ...atBoundary.signal, finalizedAt: '2026-07-02T00:00:00.000Z' },
      planningBrokerState: { ...atBoundary.planningBrokerState, observedAt: '2026-07-02T00:00:00.000Z' },
    })
    expect(Result.isSuccess(accepted)).toBe(true)

    const beforeBoundary = bindExecutionSession({
      ...atBoundary,
      signal: { ...atBoundary.signal, finalizedAt: '2026-07-01T23:59:59.999Z' },
      planningBrokerState: { ...atBoundary.planningBrokerState, observedAt: '2026-07-01T23:59:59.999Z' },
    })
    expect(Result.isFailure(beforeBoundary)).toBe(true)
    if (Result.isFailure(beforeBoundary)) {
      expect(beforeBoundary.failure).toMatchObject({
        _tag: 'ExecutionSessionBindingFailure',
        operation: 'derive-window',
        reason: 'signal-finalization',
        facts: {
          finalizedAt: '2026-07-01T23:59:59.999Z',
          signalSessionDate: '2026-07-02',
        },
      })
    }
  })

  test('rejects a rehashed binding whose cutoff does not match the declared lead', () => {
    const observation = calendar([
      { date: '2026-07-06', openAt: '2026-07-06T13:30:00.000Z', closeAt: '2026-07-06T20:00:00.000Z' },
    ])
    const valid = bind(observation)
    const { bindingHash: _, ...validMaterial } = valid
    const tamperedMaterial = {
      ...validMaterial,
      submissionCutoffAt: '2026-07-06T13:29:59.999Z',
    }

    expect(() =>
      decodeBinding({
        ...tamperedMaterial,
        bindingHash: canonicalHashV1(tamperedMaterial),
      }),
    ).toThrow('must equal execution open minus the declared fixed cutoff lead')
  })

  test('rejects a rehashed execution session that is not selected by the bound calendar observation', () => {
    const valid = bind(
      calendar([{ date: '2026-07-06', openAt: '2026-07-06T13:30:00.000Z', closeAt: '2026-07-06T20:00:00.000Z' }]),
    )
    const { bindingHash: _, ...validMaterial } = valid
    const tamperedMaterial = {
      ...validMaterial,
      executionSession: {
        date: '2026-07-07',
        openAt: '2026-07-07T13:30:00.000Z',
        closeAt: '2026-07-07T20:00:00.000Z',
      },
      submissionCutoffAt: '2026-07-07T13:15:00.000Z',
    }

    expect(() =>
      decodeBinding({
        ...tamperedMaterial,
        bindingHash: canonicalHashV1(tamperedMaterial),
      }),
    ).toThrow('must be the first post-signal session in the supplied normalized calendar observation')
  })

  test('rejects a rehashed calendar whose UTC instants do not belong to the declared session date', () => {
    const valid = bind(
      calendar([{ date: '2026-07-06', openAt: '2026-07-06T13:30:00.000Z', closeAt: '2026-07-06T20:00:00.000Z' }]),
    )
    const shiftedSession = {
      date: '2026-07-06',
      openAt: '2026-07-10T13:30:00.000Z',
      closeAt: '2026-07-10T20:00:00.000Z',
    } as const
    const shiftedCalendarMaterial = {
      ...valid.calendar,
      sessions: [shiftedSession],
    }
    const { normalizedResponseHash: _, ...calendarMaterial } = shiftedCalendarMaterial
    const shiftedCalendar = {
      ...calendarMaterial,
      normalizedResponseHash: canonicalHashV1(calendarMaterial),
    }
    const { bindingHash: __, ...validMaterial } = valid
    const tamperedMaterial = {
      ...validMaterial,
      calendar: shiftedCalendar,
      executionSession: shiftedSession,
      submissionCutoffAt: '2026-07-10T13:15:00.000Z',
    }

    expect(() =>
      decodeBinding({
        ...tamperedMaterial,
        bindingHash: canonicalHashV1(tamperedMaterial),
      }),
    ).toThrow('must have ordered UTC hours on their declared date within the request')
  })

  test('rejects a truncated calendar range that can skip the actual next exchange session', () => {
    expect(() =>
      bind(
        calendar([{ date: '2026-07-10', openAt: '2026-07-10T13:30:00.000Z', closeAt: '2026-07-10T20:00:00.000Z' }], {
          start: '2026-07-10',
          end: '2026-07-10',
        }),
      ),
    ).toThrow('market calendar request must start on or before the signal session')
  })

  test('binds one complete real calendar to the exact durable cycle and preserves adjacency evidence', () => {
    const binding = bindCycle()

    expect(binding).toMatchObject({
      signal: { sessionDate: '2026-01-30' },
      calendar: monthEndCalendar,
      executionSession: {
        date: '2026-02-02',
        openAt: '2026-02-02T14:30:00.000Z',
        closeAt: '2026-02-02T21:00:00.000Z',
      },
      submissionOpenAt: '2026-02-02T13:45:00.000Z',
      submissionCutoffAt: '2026-02-02T14:15:00.000Z',
      submissionCutoffLeadMinutes: 15,
    })
  })

  test('binds the opening-drive cycle to its exact post-open decision and cutoff offsets', () => {
    const cycle = makeActiveOpeningCycle()
    const binding = bindCycleExecutionSessionSuccess({
      cycle,
      executionSessionDate: cycle.identity.executionSessionDate,
      planningBrokerState: {
        observedAt: cycle.window.submissionOpenAt,
        contentHash: hash('8'),
      },
      calendar: monthEndCalendar,
      executionModel: openingDriveExecutionModel,
    })

    expect(binding).toMatchObject({
      schemaVersion: 'bayn.execution-session-binding.v3',
      executionSession: {
        date: '2026-02-02',
        openAt: '2026-02-02T14:30:00.000Z',
        closeAt: '2026-02-02T21:00:00.000Z',
      },
      submissionOpenAt: '2026-02-02T14:35:01.000Z',
      submissionCutoffAt: '2026-02-02T15:00:00.000Z',
      decisionAfterOpenMs: 301_000,
      submissionCutoffAfterOpenMs: 1_800_000,
    })

    const policy = cycle.identity.executionPolicy
    if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v2') return expect.unreachable()
    const inconsistentPolicy = resultValue(
      makeCycleExecutionPolicy({
        schemaVersion: policy.schemaVersion,
        strategyExecutionModelHash: policy.strategyExecutionModelHash,
        submissionWindowMs: policy.submissionWindowMs - 1,
        submissionCutoffAfterOpenMs: policy.submissionCutoffAfterOpenMs,
      }),
    )
    const mismatch = bindCycleExecutionSession({
      cycle: makeActiveOpeningCycle(inconsistentPolicy),
      executionSessionDate: cycle.identity.executionSessionDate,
      planningBrokerState: {
        observedAt: cycle.window.submissionOpenAt,
        contentHash: hash('8'),
      },
      calendar: monthEndCalendar,
      executionModel: openingDriveExecutionModel,
    })
    expect(Result.isFailure(mismatch)).toBeTrue()
    if (Result.isFailure(mismatch)) {
      expect(mismatch.failure).toMatchObject({
        operation: 'bind-cycle',
        reason: 'cycle-policy',
        facts: {
          field: 'decisionAfterOpenMs',
          expected: 301_001,
          observed: 301_000,
        },
      })
    }
  })

  test('binds rolling intraday execution to warmup and the actual session close', () => {
    const cycle = makeActiveIntradayMomentumCycle()
    const binding = bindCycleExecutionSessionSuccess({
      cycle,
      executionSessionDate: cycle.identity.executionSessionDate,
      planningBrokerState: {
        observedAt: cycle.window.submissionOpenAt,
        contentHash: hash('9'),
      },
      calendar: monthEndCalendar,
      executionModel: intradayMomentumExecutionModel,
    })

    expect(binding).toMatchObject({
      schemaVersion: 'bayn.execution-session-binding.v3',
      submissionOpenAt: '2026-02-02T15:00:00.000Z',
      submissionCutoffAt: '2026-02-02T20:00:00.000Z',
      decisionAfterOpenMs: 1_800_000,
      submissionCutoffAfterOpenMs: 19_800_000,
    })
  })

  test('decodes the durable signal-bound v2 opening-drive contract without changing its hash material', () => {
    const persisted = bindExecutionSessionSuccess({
      signal: {
        sessionDate: '2026-01-30',
        finalizedAt: '2026-01-30T21:15:00.000Z',
        contentHash: hash('7'),
      },
      planningBrokerState: {
        observedAt: '2026-02-02T14:35:01.000Z',
        contentHash: hash('8'),
      },
      calendar: monthEndCalendar,
      executionModel: openingDriveExecutionModel,
    })

    expect(persisted).toMatchObject({
      schemaVersion: 'bayn.execution-session-binding.v2',
      signal: { sessionDate: '2026-01-30' },
      executionSession: { date: '2026-02-02' },
      submissionOpenAt: '2026-02-02T14:35:01.000Z',
      submissionCutoffAt: '2026-02-02T15:00:00.000Z',
    })
    expect(decodeBinding(structuredClone(persisted))).toEqual(persisted)
  })

  test('narrows an opening-drive submission window to later reconciled broker evidence', () => {
    const cycle = makeActiveOpeningCycle()
    const narrowed = bindCycleExecutionSessionSuccess({
      cycle,
      executionSessionDate: cycle.identity.executionSessionDate,
      planningBrokerState: {
        observedAt: '2026-02-02T14:45:00.000Z',
        contentHash: hash('8'),
      },
      calendar: monthEndCalendar,
      executionModel: openingDriveExecutionModel,
    })

    expect(narrowed.submissionOpenAt).toBe('2026-02-02T14:45:00.000Z')

    const exhausted = bindCycleExecutionSession({
      cycle,
      executionSessionDate: cycle.identity.executionSessionDate,
      planningBrokerState: {
        observedAt: '2026-02-02T15:00:00.000Z',
        contentHash: hash('8'),
      },
      calendar: monthEndCalendar,
      executionModel: openingDriveExecutionModel,
    })
    expect(Result.isFailure(exhausted)).toBeTrue()
    if (Result.isFailure(exhausted)) {
      expect(String(exhausted.failure)).toContain('submissionOpenAt < submissionCutoffAt')
    }
  })

  test('binds cycle signal finalization only at or after the durable signal close boundary', () => {
    const cycle = makeActiveCycle()
    const atClose = bindCycle({
      signal: {
        sessionDate: cycle.identity.signalSessionDate,
        finalizedAt: cycle.window.signalCloseAt,
        contentHash: hash('c'),
      },
    })
    const afterClose = bindCycle({
      signal: {
        sessionDate: cycle.identity.signalSessionDate,
        finalizedAt: '2026-01-30T21:00:00.001Z',
        contentHash: hash('d'),
      },
    })
    expect(atClose.signal.finalizedAt).toBe(cycle.window.signalCloseAt)
    expect(afterClose.signal.finalizedAt).toBe('2026-01-30T21:00:00.001Z')

    const beforeClose = bindCycleExecutionSession(
      cycleBindingInput({
        signal: {
          sessionDate: cycle.identity.signalSessionDate,
          finalizedAt: '2026-01-30T20:59:59.999Z',
          contentHash: hash('e'),
        },
      }),
    )
    expect(Result.isFailure(beforeClose)).toBe(true)
    if (Result.isFailure(beforeClose)) {
      expect(beforeClose.failure).toMatchObject({
        operation: 'bind-cycle',
        reason: 'cycle-window',
        facts: {
          cycleId: cycle.identity.cycleId,
          expectedMinimumSignalFinalizedAt: cycle.window.signalCloseAt,
          observedSignalFinalizedAt: '2026-01-30T20:59:59.999Z',
        },
      })
    }
  })

  test('allows later evidence to narrow but never widen the durable cycle submission window', () => {
    const baseline = bindCycle()
    const narrowed = bindCycle({
      planningBrokerState: {
        observedAt: '2026-02-02T14:00:00.000Z',
        contentHash: hash('c'),
      },
    })
    expect(narrowed.submissionOpenAt).toBe('2026-02-02T14:00:00.000Z')
    expect(narrowed.bindingHash).not.toBe(baseline.bindingHash)
    const { bindingHash: _, ...narrowedMaterial } = narrowed
    expect(narrowed.bindingHash).toBe(canonicalHashV1(narrowedMaterial))

    const widened = bindCycleExecutionSession(
      cycleBindingInput({
        planningBrokerState: {
          observedAt: '2026-02-02T13:44:59.999Z',
          contentHash: hash('d'),
        },
      }),
    )
    expect(Result.isFailure(widened)).toBe(true)
    if (Result.isFailure(widened)) {
      expect(widened.failure).toMatchObject({
        operation: 'bind-cycle',
        reason: 'cycle-window',
        facts: {
          expectedMinimumSubmissionOpenAt: makeActiveCycle().window.submissionOpenAt,
          observedSubmissionOpenAt: '2026-02-02T13:44:59.999Z',
        },
      })
    }
  })

  test('fails closed when the complete calendar no longer selects the cycle session', () => {
    const cycle = makeActiveCycle()
    const signalMismatch = bindCycleExecutionSession(
      cycleBindingInput({
        signal: {
          sessionDate: '2026-01-31',
          finalizedAt: '2026-01-31T21:15:00.000Z',
          contentHash: hash('e'),
        },
      }),
    )
    expect(Result.isFailure(signalMismatch)).toBe(true)
    if (Result.isFailure(signalMismatch)) {
      expect(signalMismatch.failure.facts).toEqual({
        cycleId: cycle.identity.cycleId,
        field: 'signalSessionDate',
        expected: '2026-01-30',
        observed: '2026-01-31',
      })
    }

    const changedHours = calendar(
      monthEndCalendar.sessions.map((session) =>
        session.date === '2026-02-02' ? { ...session, closeAt: '2026-02-02T18:00:00.000Z' } : session,
      ),
      monthEndCalendar.requestedRange,
    )
    const hoursMismatch = bindCycleExecutionSession(cycleBindingInput({ calendar: changedHours }))
    expect(Result.isFailure(hoursMismatch)).toBe(true)
    if (Result.isFailure(hoursMismatch)) {
      expect(hoursMismatch.failure.facts).toEqual({
        cycleId: cycle.identity.cycleId,
        field: 'executionCloseAt',
        expected: '2026-02-02T21:00:00.000Z',
        observed: '2026-02-02T18:00:00.000Z',
      })
    }

    const skippedSession = calendar(
      monthEndCalendar.sessions.filter((session) => session.date !== '2026-02-02'),
      monthEndCalendar.requestedRange,
    )
    const dateMismatch = bindCycleExecutionSession(cycleBindingInput({ calendar: skippedSession }))
    expect(Result.isFailure(dateMismatch)).toBe(true)
    if (Result.isFailure(dateMismatch)) {
      expect(dateMismatch.failure.facts).toEqual({
        cycleId: cycle.identity.cycleId,
        field: 'executionSessionDate',
        expected: '2026-02-02',
        observed: '2026-02-03',
      })
    }
  })

  test('fails closed when the current execution model differs from the cycle policy', () => {
    const changedModel = {
      ...causalExecutionModel,
      order: {
        ...causalExecutionModel.order,
        submissionCutoffLeadMinutes: causalExecutionModel.order.submissionCutoffLeadMinutes - 1,
      },
    }

    const mismatch = bindCycleExecutionSession(cycleBindingInput({ executionModel: changedModel }))
    expect(Result.isFailure(mismatch)).toBe(true)
    if (Result.isFailure(mismatch)) {
      expect(mismatch.failure).toMatchObject({
        operation: 'bind-cycle',
        reason: 'cycle-policy',
        facts: {
          cycleId: makeActiveCycle().identity.cycleId,
          field: 'strategyExecutionModelHash',
          expected: makeActiveCycle().identity.executionPolicy.strategyExecutionModelHash,
          observed: canonicalHashV1(changedModel),
        },
      })
    }

    const shorterLeadPolicy = resultValue(
      makeCycleExecutionPolicy({
        schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
        strategyExecutionModelHash: canonicalHashV1(causalExecutionModel),
        submissionWindowMs: 30 * 60_000,
        submissionCutoffBeforeOpenMs: 14 * 60_000,
      }),
    )
    const shorterLeadCycle = makeActiveCycle(shorterLeadPolicy)
    const leadMismatch = bindCycleExecutionSession(cycleBindingInput({ cycle: shorterLeadCycle }))
    expect(Result.isFailure(leadMismatch)).toBe(true)
    if (Result.isFailure(leadMismatch)) {
      expect(leadMismatch.failure).toMatchObject({
        operation: 'bind-cycle',
        reason: 'cycle-policy',
        facts: {
          cycleId: shorterLeadCycle.identity.cycleId,
          field: 'submissionCutoffBeforeOpenMs',
          expected: 14 * 60_000,
          observed: 15 * 60_000,
        },
      })
    }
  })

  test('returns each reachable closed failure reason from the exported binders', () => {
    const futureSession = {
      date: '2026-07-06',
      openAt: '2026-07-06T13:30:00.000Z',
      closeAt: '2026-07-06T20:00:00.000Z',
    } as const
    const validCalendar = calendar([futureSession])
    const invalidHashCalendar = {
      ...validCalendar,
      sessions: [{ ...futureSession, closeAt: '2026-07-06T19:00:00.000Z' }],
    }
    const reversedRangeCalendar = calendar([futureSession], {
      start: '2026-07-10',
      end: '2026-07-02',
    })
    const wrongDateCalendar = calendar([
      {
        ...futureSession,
        openAt: '2026-07-07T13:30:00.000Z',
        closeAt: '2026-07-07T20:00:00.000Z',
      },
    ])
    const unorderedCalendar = calendar([
      {
        date: '2026-07-07',
        openAt: '2026-07-07T13:30:00.000Z',
        closeAt: '2026-07-07T20:00:00.000Z',
      },
      futureSession,
    ])
    const noFutureSessionCalendar = calendar([
      {
        date: '2026-07-02',
        openAt: '2026-07-02T13:30:00.000Z',
        closeAt: '2026-07-02T20:00:00.000Z',
      },
    ])
    const atCutoffInput = {
      ...bindingInput(validCalendar),
      signal: {
        ...bindingInput(validCalendar).signal,
        finalizedAt: '2026-07-06T13:15:00.000Z',
      },
    }
    const prematureFinalizationInput = {
      ...bindingInput(validCalendar),
      signal: {
        ...bindingInput(validCalendar).signal,
        finalizedAt: '2026-07-01T23:59:59.999Z',
      },
      planningBrokerState: {
        ...bindingInput(validCalendar).planningBrokerState,
        observedAt: '2026-07-01T23:59:59.999Z',
      },
    }
    const changedModel = {
      ...causalExecutionModel,
      order: {
        ...causalExecutionModel.order,
        submissionCutoffLeadMinutes: causalExecutionModel.order.submissionCutoffLeadMinutes - 1,
      },
    }
    const cases = [
      ['bind', 'decode', bindExecutionSession({})],
      ['derive-window', 'calendar-hash', bindExecutionSession(bindingInput(invalidHashCalendar))],
      ['derive-window', 'range', bindExecutionSession(bindingInput(reversedRangeCalendar))],
      ['derive-window', 'calendar-session', bindExecutionSession(bindingInput(wrongDateCalendar))],
      ['derive-window', 'calendar-order', bindExecutionSession(bindingInput(unorderedCalendar))],
      ['derive-window', 'future-session', bindExecutionSession(bindingInput(noFutureSessionCalendar))],
      ['derive-window', 'signal-finalization', bindExecutionSession(prematureFinalizationInput)],
      ['derive-window', 'submission-window', bindExecutionSession(atCutoffInput)],
      ['bind-cycle', 'decode', bindCycleExecutionSession({})],
      [
        'bind-cycle',
        'cycle-calendar',
        bindCycleExecutionSession(
          cycleBindingInput({
            signal: {
              sessionDate: '2026-01-31',
              finalizedAt: '2026-01-31T21:15:00.000Z',
              contentHash: hash('e'),
            },
          }),
        ),
      ],
      ['bind-cycle', 'cycle-policy', bindCycleExecutionSession(cycleBindingInput({ executionModel: changedModel }))],
      [
        'bind-cycle',
        'cycle-window',
        bindCycleExecutionSession(
          cycleBindingInput({
            planningBrokerState: {
              observedAt: '2026-02-02T13:44:59.999Z',
              contentHash: hash('d'),
            },
          }),
        ),
      ],
    ] as const

    for (const [operation, reason, result] of cases) {
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: 'ExecutionSessionBindingFailure',
          operation,
          reason,
        })
      }
    }
  })
})
