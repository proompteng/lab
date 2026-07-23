import { describe, expect, test } from 'bun:test'

import { Schema } from 'effect'

import type { MarketCalendarObservation } from './broker/alpaca'
import {
  CycleState,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
} from './cycle'
import { defaultExecutionModel } from './execution-model'
import { bindCycleExecutionSession, bindExecutionSession, ExecutionSessionBindingSchema } from './execution-session'
import { canonicalHashV1 } from './hash'
import { strictParseOptions } from './schemas'

const hash = (character: string): string => character.repeat(64)
const causalExecutionModel = (() => {
  if (defaultExecutionModel.schemaVersion !== 'bayn.execution-model.v2') {
    throw new Error('execution-session cycle fixtures require the causal v2 execution model')
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

const bind = (observation: MarketCalendarObservation) =>
  bindExecutionSession({
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

const makeActiveCycle = (): AutonomousCycle => {
  const executionSession = monthEndCalendar.sessions[1]
  if (executionSession === undefined) throw new Error('cycle fixture requires the first post-signal session')
  const executionCalendar = makeExecutionCalendarObservation({
    schemaVersion: monthEndCalendar.schemaVersion,
    source: monthEndCalendar.source,
    ...executionSession,
  })
  const executionPolicy = makeCycleExecutionPolicyFromModel(causalExecutionModel)
  const identity = makeCycleIdentity({
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
  })
  const window = makeCycleWindow(
    {
      calendar_version: 'signal-calendar-v1',
      session_date: '2026-01-30',
      close_time: '16:00',
      timezone: 'America/New_York',
    },
    executionCalendar,
    executionPolicy,
  )
  return {
    ...makeCycleDraft(identity, window),
    state: CycleState.Active,
    bindings: { snapshotId: hash('3') },
    stateVersion: 3,
    createdAt: '2026-01-30T21:15:00.000Z',
    updatedAt: window.submissionOpenAt,
  }
}

const bindCycle = (overrides: Partial<Parameters<typeof bindCycleExecutionSession>[0]> = {}) => {
  const cycle = makeActiveCycle()
  return bindCycleExecutionSession({
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
  })
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
    expect(result.bindingHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('preserves the DST-normalized open supplied by the bounded broker observation', () => {
    const result = bindExecutionSession({
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
      bindExecutionSession({
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
    ).toThrow('must be the first post-signal session in the normalized calendar observation')
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
    ).toThrow('must have valid hours on its declared UTC session date within the requested range')
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

  test('allows later evidence to narrow but never widen the durable cycle submission window', () => {
    expect(
      bindCycle({
        planningBrokerState: {
          observedAt: '2026-02-02T14:00:00.000Z',
          contentHash: hash('c'),
        },
      }).submissionOpenAt,
    ).toBe('2026-02-02T14:00:00.000Z')

    expect(() =>
      bindCycle({
        planningBrokerState: {
          observedAt: '2026-02-02T13:44:59.999Z',
          contentHash: hash('d'),
        },
      }),
    ).toThrow('cannot widen the durable cycle submission window')
  })

  test('fails closed when the complete calendar no longer selects the cycle session', () => {
    expect(() =>
      bindCycle({
        signal: {
          sessionDate: '2026-01-31',
          finalizedAt: '2026-01-30T21:15:00.000Z',
          contentHash: hash('e'),
        },
      }),
    ).toThrow('does not match the durable cycle calendar')

    const changedHours = calendar(
      monthEndCalendar.sessions.map((session) =>
        session.date === '2026-02-02' ? { ...session, closeAt: '2026-02-02T18:00:00.000Z' } : session,
      ),
      monthEndCalendar.requestedRange,
    )
    expect(() => bindCycle({ calendar: changedHours })).toThrow('does not match the durable cycle calendar')

    const skippedSession = calendar(
      monthEndCalendar.sessions.filter((session) => session.date !== '2026-02-02'),
      monthEndCalendar.requestedRange,
    )
    expect(() => bindCycle({ calendar: skippedSession })).toThrow('does not match the durable cycle calendar')
  })

  test('fails closed when the current execution model differs from the cycle policy', () => {
    const changedModel = {
      ...causalExecutionModel,
      order: {
        ...causalExecutionModel.order,
        submissionCutoffLeadMinutes: causalExecutionModel.order.submissionCutoffLeadMinutes - 1,
      },
    }

    expect(() => bindCycle({ executionModel: changedModel })).toThrow(
      'does not match the durable cycle execution policy',
    )
  })
})
