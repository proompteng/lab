import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { calendarFixture, registrationFixture, testHash } from './fixtures.test-support'
import { validateSystemRegistration } from './policy'
import { ObligationClass } from './reliability'
import { registeredSchedule } from './schedule'

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
