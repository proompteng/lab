import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { qualificationCalendar } from './calendar'
import { supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { evaluateSystemAssessment } from './assessment'
import { continuousMarketHours } from '../market-hours'

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
