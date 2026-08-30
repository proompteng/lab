import { expect, test } from 'bun:test'

import { Result } from 'effect'

import type { MarketCalendarObservation } from '../../broker/alpaca'
import { makeCycleExecutionPolicy } from '../construction'
import { selectIntradayExecutionSession } from './calendar-decisions'

test('intraday session selection includes the strategy decision delay', () => {
  const policy = makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3',
    strategyExecutionModelHash: '0'.repeat(64),
    warmupAfterOpenMs: 30 * 60_000,
    submissionCutoffBeforeCloseMs: 60 * 60_000,
  })
  if (Result.isFailure(policy)) throw policy.failure
  if (policy.success.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') {
    throw new Error('decision-delay fixture requires the full-session execution policy')
  }
  const observation: MarketCalendarObservation = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    requestedRange: { start: '2026-11-27', end: '2026-11-30' },
    timeZone: 'UTC',
    sessions: [
      {
        date: '2026-11-27',
        openAt: '2026-11-27T14:30:00.000Z',
        closeAt: '2026-11-27T16:00:01.000Z',
      },
      {
        date: '2026-11-30',
        openAt: '2026-11-30T14:30:00.000Z',
        closeAt: '2026-11-30T21:00:00.000Z',
      },
    ],
    normalizedResponseHash: '1'.repeat(64),
  }

  expect(selectIntradayExecutionSession(observation, policy.success, '2026-11-27T14:00:00.000Z')?.date).toBe(
    '2026-11-30',
  )
})
