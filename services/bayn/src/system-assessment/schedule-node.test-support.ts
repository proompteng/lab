import { strict as assert } from 'node:assert'
import { Result } from 'effect'

import { registrationFixture } from './fixtures.test-support'
import { registeredSchedule } from './schedule'
import { ObligationClass } from './reliability'

const base = registrationFixture()
const schedule = Result.getOrThrow(
  registeredSchedule({
    ...base,
    calendar: {
      ...base.calendar,
      sessions: base.calendar.sessions.map((session) => ({
        ...session,
        closeAt: session.closeAt.replace('14:32', '21:00'),
      })),
    },
    obligations: { ...base.obligations, reconciliationIntervalMs: 1000 },
  }),
)
assert.equal(schedule.filter((item) => item.class === ObligationClass.Reconciliation).length, 468000)
assert.equal(schedule.filter((item) => item.class === ObligationClass.Decision).length, 7780)
assert.equal(new Set(schedule.map((item) => item.obligationId)).size, schedule.length)
assert.equal(schedule.at(-1)?.dueAt, '2026-11-27T20:59:59.000Z')
