import { describe, expect, test } from 'bun:test'

import type { MarketCalendarObservation } from './broker/alpaca'
import { defaultExecutionModel } from './execution-model'
import { bindExecutionSession } from './execution-session'
import { canonicalHashV1 } from './hash'

const hash = (character: string): string => character.repeat(64)

const calendar = (
  sessions: MarketCalendarObservation['sessions'],
  requestedRange = { start: '2026-07-03', end: '2026-07-10' },
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
        { start: '2026-03-07', end: '2026-03-10' },
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
})
