import { describe, expect, test } from 'bun:test'

import { Effect, Result } from 'effect'

import type { MarketCalendarObservation } from '../../broker/alpaca'
import { makeCycleExecutionPolicy } from '../construction'
import { CycleState, decodeAutonomousCycle } from '../model'
import {
  intradayEntryRearmDelayMs,
  makeIntradayCycleDraft,
  nextIntradayEntryAttemptOrdinal,
  selectIntradayExecutionSession,
} from './calendar-decisions'

const policy = Result.getOrThrow(
  makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3',
    strategyExecutionModelHash: '0'.repeat(64),
    warmupAfterOpenMs: 30 * 60_000,
    submissionCutoffBeforeCloseMs: 60 * 60_000,
  }),
)
if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') {
  throw new Error('calendar decision fixture requires the full-session execution policy')
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

describe('intraday calendar decisions', () => {
  test('includes the strategy decision delay when selecting a session', () => {
    expect(selectIntradayExecutionSession(observation, policy, '2026-11-27T14:00:00.000Z')?.date).toBe('2026-11-30')
  })

  test('derives a distinct cycle for every session under the same standing mandate', () => {
    const candidate = {
      cycleBindingId: '2'.repeat(64),
      strategyName: 'intraday-momentum' as const,
      strategyProtocolHash: '3'.repeat(64),
      accountId: 'sandbox-account',
      executionPolicy: policy,
    }
    const [fridaySession, mondaySession] = observation.sessions
    if (fridaySession === undefined || mondaySession === undefined) throw new Error('calendar fixture is incomplete')
    const friday = Result.getOrThrow(makeIntradayCycleDraft(candidate, observation, fridaySession))
    const monday = Result.getOrThrow(makeIntradayCycleDraft(candidate, observation, mondaySession))

    expect(friday.identity.qualificationRunId).toBe(candidate.cycleBindingId)
    expect(monday.identity.qualificationRunId).toBe(candidate.cycleBindingId)
    expect(friday.identity.executionSessionDate).toBe('2026-11-27')
    expect(monday.identity.executionSessionDate).toBe('2026-11-30')
    expect(friday.schemaVersion).toBe('bayn.autonomous-cycle.v4')
    expect(friday.identity).toMatchObject({
      schemaVersion: 'bayn.autonomous-cycle-identity.v4',
      entryAttemptOrdinal: 1,
    })
    expect(monday.identity.cycleId).not.toBe(friday.identity.cycleId)
  })

  test('rearms successive zero-fill attempts until the session cutoff with distinct immutable cycles', () => {
    const candidate = {
      cycleBindingId: '2'.repeat(64),
      strategyName: 'intraday-momentum' as const,
      strategyProtocolHash: '3'.repeat(64),
      accountId: 'sandbox-account',
      executionPolicy: policy,
    }
    const session = observation.sessions[1]
    if (session === undefined) throw new Error('calendar fixture is incomplete')
    const firstDraft = Result.getOrThrow(makeIntradayCycleDraft(candidate, observation, session, 1))
    const secondDraft = Result.getOrThrow(makeIntradayCycleDraft(candidate, observation, session, 2))
    const terminalAt = '2026-11-30T15:30:00.000Z'
    const first = Effect.runSync(
      decodeAutonomousCycle({
        ...firstDraft,
        state: CycleState.Completed,
        bindings: { snapshotId: '4'.repeat(64), decisionHash: '5'.repeat(64) },
        stateVersion: 2,
        createdAt: firstDraft.window.submissionOpenAt,
        updatedAt: terminalAt,
        terminalAt,
      }),
    )
    const beforeRearm = new Date(Date.parse(terminalAt) + intradayEntryRearmDelayMs - 1).toISOString()
    const atRearm = new Date(Date.parse(terminalAt) + intradayEntryRearmDelayMs).toISOString()

    expect(secondDraft.identity.cycleId).not.toBe(firstDraft.identity.cycleId)
    expect(secondDraft.identity).toMatchObject({ entryAttemptOrdinal: 2 })
    expect(nextIntradayEntryAttemptOrdinal(first, beforeRearm)).toBeUndefined()
    expect(nextIntradayEntryAttemptOrdinal(first, atRearm)).toBe(2)

    const second = Effect.runSync(
      decodeAutonomousCycle({
        ...secondDraft,
        state: CycleState.Completed,
        bindings: { snapshotId: '6'.repeat(64), decisionHash: '7'.repeat(64) },
        stateVersion: 2,
        createdAt: secondDraft.window.submissionOpenAt,
        updatedAt: atRearm,
        terminalAt: atRearm,
      }),
    )
    expect(
      nextIntradayEntryAttemptOrdinal(second, new Date(Date.parse(atRearm) + intradayEntryRearmDelayMs).toISOString()),
    ).toBe(3)
    const thirdDraft = Result.getOrThrow(makeIntradayCycleDraft(candidate, observation, session, 3))
    expect(thirdDraft.identity.cycleId).not.toBe(secondDraft.identity.cycleId)
    expect(nextIntradayEntryAttemptOrdinal(second, second.window.submissionCutoffAt)).toBeUndefined()
    expect(nextIntradayEntryAttemptOrdinal({ ...second, state: CycleState.Active }, atRearm)).toBeUndefined()
  })
})
