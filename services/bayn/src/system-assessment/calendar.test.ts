import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { qualificationCalendar } from './calendar'
import {
  activeEvaluationSessions,
  registrationFixture,
  supportedAssessmentFixture,
  testHash,
  withRegistrationCommitments,
} from './fixtures.test-support'
import { evaluateSystemAssessment } from './assessment'
import { continuousMarketHours } from '../market-hours'
import { validateSystemRegistration } from './policy'

describe('prospective broker calendar binding', () => {
  test('reproduces every registered regular session from the complete broker response', () => {
    const { input } = supportedAssessmentFixture()
    const actual = Result.getOrThrow(qualificationCalendar(input.calendarEvidence))
    expect(actual.sourceHash).toBe(input.registration.calendar.sourceHash)
    expect(actual.sessions).toEqual([...input.registration.calendar.sessions])
  })
  test('a continuous calendar cannot establish a regular equity-session claim', () => {
    expect(Result.isFailure(qualificationCalendar(continuousMarketHours))).toBe(true)
  })
  test('omitting a session, retiming its bounds, or replacing its response prevents qualification', () => {
    const { input, verifiedSources } = supportedAssessmentFixture()
    const calendar = input.calendarEvidence
    if (calendar === null || calendar.schemaVersion !== 'bayn.alpaca-market-calendar-observation.v2')
      throw new Error('Missing calendar')
    const { normalizedResponseHash: _, ...material } = calendar
    const shortened = {
      ...material,
      sessions: material.sessions.filter((_s, i) => i !== 3),
      providerSessions: material.providerSessions.filter((_s, i) => i !== 3),
    }
    const substituted = { ...shortened, normalizedResponseHash: testHash(shortened) }
    for (const changed of [null, substituted, { ...calendar, normalizedResponseHash: testHash('substitute') }]) {
      const result = Result.getOrThrow(
        evaluateSystemAssessment({ ...input, calendarEvidence: changed }, verifiedSources),
      )
      expect(result.verdict).not.toBe('QUALIFIED_PAPER')
    }
  })
})

test.each([
  '2026-10-27T12:00:00.000Z',
  '2026-10-27T23:58:30.000Z',
  '2026-10-27T23:59:58.499Z',
  '2026-10-27T23:59:58.500Z',
])('active witness calendars remain prospective and within UTC dates at %s', (now) => {
  const { opens, sessions } = activeEvaluationSessions(Date.parse(now))
  const base = registrationFixture(new Date(Date.parse(now) - 1000).toISOString())
  const registration = withRegistrationCommitments({ ...base, calendar: { ...base.calendar, sessions } })
  expect(Result.getOrThrow(validateSystemRegistration(registration)).registration).toEqual(registration)
  expect(opens).toBeGreaterThan(Date.parse(now))
  expect(sessions).toHaveLength(20)
  for (const session of sessions) {
    expect(session.openAt.slice(0, 10)).toBe(session.sessionDate)
    expect(session.closeAt.slice(0, 10)).toBe(session.sessionDate)
    expect(Date.parse(session.closeAt)).toBeGreaterThan(Date.parse(session.openAt))
  }
})
