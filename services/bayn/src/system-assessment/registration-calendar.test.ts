import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { calendarFixture, nativeRegistrationFixture, registrationFixture, testHash } from './fixtures.test-support'
import { nativeBrokerRecoveryClose, validateProspectiveSystemRegistration, validateSystemRegistration } from './policy'
import { ObligationClass } from './reliability'
import { registeredSchedule } from './schedule'
import { preparedAlphaRegistrationFixture } from './prepared-alpha-registration.test-support'

test.each(['2026-11-02T14:30:00.000Z', '2027-01-01T00:00:00.000Z', '2040-02-29T23:59:59.999Z'])(
  'registration fixtures keep their complete prospective commitments after %s',
  (registeredAt) => {
    const fixture = registrationFixture(registeredAt)
    const first = fixture.calendar.sessions[0]
    if (first === undefined) throw new Error('Missing first session')
    expect(Date.parse(first.openAt)).toBeGreaterThan(Date.parse(registeredAt))
    expect(fixture.registeredAt).toBe(registeredAt)
    expect(fixture.calendar.sessions).toHaveLength(20)
    expect(fixture.calendar.sourceHash).toBe(testHash(calendarFixture(fixture)))
    expect(Result.isSuccess(validateSystemRegistration(fixture))).toBe(true)
    for (const obligation of Result.getOrThrow(registeredSchedule(fixture)))
      expect(obligation.scheduleEvidenceHash).toBe(
        obligation.class === ObligationClass.Decision
          ? fixture.obligations.decisionScheduleHash
          : fixture.obligations.reconciliationScheduleHash,
      )
    const dates = new Set(fixture.calendar.sessions.map((session) => session.sessionDate))
    expect(fixture.costAllocationPlans.every((plan) => dates.has(plan.serviceStartDate))).toBe(true)
  },
)

test('new registrations bind the complete native broker calendar and original native deadlines', () => {
  const retained = registrationFixture(undefined, 2)
  const dates = retained.calendar.sessions.map((session) => session.sessionDate)
  const marketCalendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      dates.map((date) => ({ date, open: '09:30', close: '16:00', session_open: '0400', session_close: '2000' })),
      { start: dates[0]!, end: dates[1]! },
    ),
  )
  const native = preparedAlphaRegistrationFixture(nativeRegistrationFixture(retained, marketCalendar))
  const accepted = Result.getOrThrow(validateProspectiveSystemRegistration(native)).registration
  expect(accepted.calendar.sessions[0]).toEqual({
    sessionDate: dates[0]!,
    openAt: `${dates[0]}T13:00:00.000Z`,
    closeAt: `${dates[0]}T22:00:00.000Z`,
  })
  expect(nativeBrokerRecoveryClose(accepted)).toBe('2026-11-04T01:00:00.000Z')
  const decisions = Result.getOrThrow(registeredSchedule(accepted)).filter(
    (row) => row.class === ObligationClass.Decision,
  )
  expect(decisions[0]?.dueAt).toBe(`${dates[0]}T13:00:02.000Z`)
  expect(decisions.filter((row) => row.dueAt.startsWith(dates[0]!)).at(-1)).toMatchObject({
    dueAt: `${dates[0]}T21:59:02.000Z`,
    deadlineAt: `${dates[0]}T22:00:02.000Z`,
  })
  expect(Result.isFailure(validateProspectiveSystemRegistration(retained))).toBe(true)
  for (const calendar of [
    { ...native.calendar, sourceHash: testHash('substituted calendar') },
    { ...native.calendar, sessions: native.calendar.sessions.slice(1) },
    { ...native.calendar, sessions: retained.calendar.sessions },
    {
      ...native.calendar,
      marketCalendar: { ...marketCalendar, sessions: marketCalendar.sessions.toReversed() },
    },
  ])
    expect(Result.isFailure(validateProspectiveSystemRegistration({ ...native, calendar }))).toBe(true)
})
