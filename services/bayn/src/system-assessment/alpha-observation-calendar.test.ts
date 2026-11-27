import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { qualificationCalendar, registeredAlphaObservationSessions } from './calendar'
import { testHash } from './fixtures.test-support'

test('alpha capture preserves native envelope and independently authenticated regular half-day bounds', () => {
  const marketCalendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      [
        { date: '2026-11-25', open: '09:30', close: '16:00', session_open: '0400', session_close: '2000' },
        { date: '2026-11-27', open: '09:30', close: '13:00', session_open: '0400', session_close: '1700' },
      ],
      { start: '2026-11-25', end: '2026-11-27' },
    ),
  )
  const native = Result.getOrThrow(qualificationCalendar(marketCalendar, 'NATIVE'))
  const calendar = { sourceHash: native.sourceHash, sessions: native.sessions, marketCalendar }
  const sessions = Result.getOrThrow(registeredAlphaObservationSessions(calendar))
  expect(sessions).toEqual([
    {
      sessionDate: '2026-11-25',
      openAt: '2026-11-25T13:00:00.000Z',
      closeAt: '2026-11-25T22:00:00.000Z',
      regularOpenAt: '2026-11-25T14:30:00.000Z',
      regularCloseAt: '2026-11-25T21:00:00.000Z',
    },
    {
      sessionDate: '2026-11-27',
      openAt: '2026-11-27T13:00:00.000Z',
      closeAt: '2026-11-27T22:00:00.000Z',
      regularOpenAt: '2026-11-27T14:30:00.000Z',
      regularCloseAt: '2026-11-27T18:00:00.000Z',
    },
  ])
  for (const changed of [
    { ...calendar, sourceHash: testHash('different calendar') },
    { ...calendar, sessions: calendar.sessions.slice(1) },
    { ...calendar, sessions: Result.getOrThrow(qualificationCalendar(marketCalendar, 'REGULAR_SESSION')).sessions },
    {
      ...calendar,
      marketCalendar: {
        ...marketCalendar,
        providerSessions: marketCalendar.providerSessions.map((session) => ({
          ...session,
          regularCloseAt: '2026-11-27T21:00:00.000Z',
        })),
      },
    },
  ])
    expect(Result.isFailure(registeredAlphaObservationSessions(changed))).toBe(true)
})
