import { expect, test } from 'bun:test'

import {
  foldBounds,
  normalizeResearchCalendar,
  requireAlignedSessions,
  requireCalendarCoverage,
  sliceFold,
} from './calendar'

const winter = { date: '2024-03-08', open: '09:30', close: '16:00' }
const summer = { date: '2024-03-11', open: '09:30', close: '16:00' }
const early = { date: '2024-11-29', open: '09:30', close: '13:00' }
const query = { start: winter.date, end: early.date }

test('normalizes authenticated calendar rows with New York DST and early closes', () => {
  const sessions = normalizeResearchCalendar({ query, response: [early, winter, summer] })
  expect(sessions).toEqual([
    { date: winter.date, openMs: Date.parse('2024-03-08T14:30:00Z'), minutes: 390 },
    { date: summer.date, openMs: Date.parse('2024-03-11T13:30:00Z'), minutes: 390 },
    { date: early.date, openMs: Date.parse('2024-11-29T14:30:00Z'), minutes: 210 },
  ])
  expect(requireCalendarCoverage(sessions, winter.date, early.date, 3)).toBe(sessions)
  expect(() => requireCalendarCoverage(sessions, winter.date, early.date, 4)).toThrow('Expected 4 sessions')
})

test('rejects malformed hours, dates outside the requested range, and duplicate sessions', () => {
  for (const response of [
    [{ ...winter, close: '16:30' }],
    [{ ...winter, open: '08:30' }],
    [{ ...winter, date: '2024-03-07' }],
    [winter, winter],
  ]) {
    expect(() => normalizeResearchCalendar({ query, response })).toThrow()
  }
})

test('requires exact chronological alignment before pairing, without filling missing sessions', () => {
  expect(() => requireAlignedSessions([winter, summer], [winter, summer])).not.toThrow()
  expect(() => requireAlignedSessions([winter, summer], [winter])).toThrow('Session count mismatch')
  expect(() => requireAlignedSessions([winter, summer], [winter, early])).toThrow('Session alignment mismatch')
  expect(() => requireAlignedSessions([summer, winter], [summer, winter])).toThrow('out-of-order')
  expect(() => requireAlignedSessions([winter, winter], [winter, winter])).toThrow('Duplicate')
})

test('slices inclusive folds without admitting neighboring sessions', () => {
  const rows = [winter, summer, early]
  const dates = rows.map(({ date }) => date)
  expect(foldBounds(dates, winter.date, summer.date, 2)).toEqual({ first: 0, end: 2 })
  expect(foldBounds(dates, early.date, early.date, 1)).toEqual({ first: 2, end: 3 })
  expect(() => foldBounds(dates, summer.date, winter.date)).toThrow('Frozen split mismatch')
  expect(() => foldBounds(dates, winter.date, '2024-03-10')).toThrow('Frozen split mismatch')
  expect(() => foldBounds(dates, winter.date, summer.date, 1)).toThrow('Frozen split mismatch')
  expect(sliceFold(rows, { start: '2024-03-09', end: summer.date })).toEqual([summer])
})
