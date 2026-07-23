import { describe, expect, test } from 'bun:test'

import { Schema } from 'effect'

import type { MarketCalendarObservation } from './broker/alpaca'
import { defaultExecutionModel } from './execution-model'
import { bindExecutionSession, ExecutionSessionBindingSchema } from './execution-session'
import { canonicalHashV1 } from './hash'
import { strictParseOptions } from './schemas'

const hash = (character: string): string => character.repeat(64)

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
})
