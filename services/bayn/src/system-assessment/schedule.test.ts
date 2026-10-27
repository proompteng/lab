import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { jevObservationQuery } from '../jev/runtime'
import { nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose } from '../jev/portfolio'
import { registeredSchedule } from './schedule'
import { ObligationClass, measureReliability } from './reliability'
import { registrationFixture, withRegistrationCommitments } from './fixtures.test-support'

describe('prospective strategy work schedule', () => {
  test('uses the first native completed minute and counts every later window independently of polling', () => {
    const native = nativeJevFixture()
    const base = registrationFixture()
    const registration = withRegistrationCommitments({
      ...base,
      calendar: {
        ...base.calendar,
        sessions: base.calendar.sessions.map((s) => ({ ...s, closeAt: s.closeAt.replace('14:32', '21:00') })),
      },
    })
    const schedule = Result.getOrThrow(registeredSchedule(registration))
    const decisions = schedule.filter((o) => o.class === ObligationClass.Decision)
    expect(decisions).toHaveLength(20 * 389)
    expect(decisions[0]).toMatchObject({ dueAt: '2026-11-02T14:31:02.000Z', deadlineAt: '2026-11-02T14:32:02.000Z' })
    expect(decisions[388]).toMatchObject({ dueAt: '2026-11-02T20:59:02.000Z', deadlineAt: '2026-11-02T21:00:00.000Z' })
    for (const poll of [1000, 5000, 60000]) {
      const changed = withRegistrationCommitments({
        ...registration,
        obligations: {
          ...registration.obligations,
          configuration: { ...registration.obligations.configuration, cyclePollIntervalMs: poll },
        },
      })
      expect(Result.getOrThrow(registeredSchedule(changed))).toEqual(schedule)
    }
    const firstDue = new Date(Date.parse(native.draft.window.executionOpenAt) + 62000).toISOString()
    const pending = jevObservationQuery(
      native.draft,
      native.protocol,
      native.snapshot.manifest.calendar,
      new Date(Date.parse(firstDue) - 1).toISOString(),
      JevPurpose.Entry,
    )
    expect(Result.isFailure(pending)).toBe(true)
    const ready = Result.getOrThrow(
      jevObservationQuery(native.draft, native.protocol, native.snapshot.manifest.calendar, firstDue, JevPurpose.Entry),
    )
    expect(ready.rangeEndAt).toBe(new Date(Date.parse(firstDue) - 2000).toISOString())
    const measured = Result.getOrThrow(
      measureReliability({ asOf: '2026-12-01T00:00:00.000Z', schedule, completions: [] }),
    )
    expect(measured.classes.find((c) => c.class === ObligationClass.Decision)).toMatchObject({
      scheduled: '7780',
      correctOnTime: '0',
      status: 'MISSES_TARGET',
    })
  })
})
