import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  decidePaperEpisode,
  decidePaperEpisodeAuthority,
  decidePaperEpisodeCycleTerminalization,
  failedPaperEpisode,
  paperGrantFromGeneration,
  paperGrantKey,
  validatePaperEpisodeCloseWindow,
  type PaperEpisodeFacts,
  type PaperEpisodeFailure,
  type PaperEpisodeState,
} from './paper-episode'

const safeFacts = (overrides: Partial<PaperEpisodeFacts> = {}): PaperEpisodeFacts => ({
  observedAt: '2026-08-04T14:00:00.000Z',
  entryCutoffAt: '2026-09-01T13:00:00.000Z',
  maximumCloseSessions: 3,
  finalizedSnapshotAvailable: true,
  nonzeroTargetAvailable: true,
  entryFilled: false,
  hasOpenPosition: false,
  closeSessionAdvanced: false,
  safety: {
    brokerRejected: false,
    dataFresh: true,
    identityMatches: true,
    reconciliationExact: true,
    restartUnambiguous: true,
    unresolvedMutationCount: 0,
  },
  ...overrides,
})

const success = (state: PaperEpisodeState, facts: PaperEpisodeFacts) => {
  const result = decidePaperEpisode(state, facts)
  expect(Result.isSuccess(result)).toBe(true)
  return Result.getOrThrow(result)
}

describe('decidePaperEpisode', () => {
  test('adapts legacy qualification history and research history to one grant boundary', () => {
    const qualified = paperGrantFromGeneration({
      schemaVersion: 'bayn.paper-authority-generation.v2',
      qualificationRunId: 'a'.repeat(64),
      qualificationLockId: 'b'.repeat(64),
      qualificationResultHash: 'c'.repeat(64),
    })
    const research = paperGrantFromGeneration({
      schemaVersion: 'bayn.paper-authority-generation.v3',
      grant: { _tag: 'Research', planHash: 'd'.repeat(64) },
    })

    expect(qualified).toEqual({
      _tag: 'Qualified',
      qualification: {
        runId: 'a'.repeat(64),
        lockId: 'b'.repeat(64),
        resultHash: 'c'.repeat(64),
      },
    })
    expect(paperGrantKey(qualified)).toBe('a'.repeat(64))
    expect(paperGrantKey(research)).toBe('d'.repeat(64))
  })

  test('starts only when a finalized snapshot has a nonzero target', () => {
    expect(success({ _tag: 'Pending' }, safeFacts())).toEqual({ _tag: 'StartEntry', state: { _tag: 'Pending' } })
    expect(success({ _tag: 'Pending' }, safeFacts({ nonzeroTargetAvailable: false }))).toEqual({
      _tag: 'WaitForEntry',
      state: { _tag: 'Pending' },
    })
  })

  test('adopts one durable entry cycle and replays it idempotently after restart', () => {
    const entering = success({ _tag: 'Pending' }, safeFacts({ cycleId: 'entry-cycle' }))
    expect(entering).toEqual({ _tag: 'Enter', state: { _tag: 'Entering', cycleId: 'entry-cycle' } })
    expect(success(entering.state, safeFacts({ cycleId: 'entry-cycle' }))).toEqual({
      _tag: 'ContinueEntry',
      state: { _tag: 'Entering', cycleId: 'entry-cycle' },
    })
  })

  test('holds a broker-confirmed entry until the monthly cutoff', () => {
    const holding = success(
      { _tag: 'Entering', cycleId: 'entry-cycle' },
      safeFacts({ cycleId: 'entry-cycle', entryFilled: true, hasOpenPosition: true }),
    )
    expect(holding).toEqual({ _tag: 'Hold', state: { _tag: 'Holding', entryCycleId: 'entry-cycle' } })
    expect(success(holding.state, safeFacts({ cycleId: 'entry-cycle', hasOpenPosition: true }))).toEqual(holding)
  })

  test('enters close-only mode at the cutoff and consumes at most three advanced sessions', () => {
    const closing = success(
      { _tag: 'Holding', entryCycleId: 'entry-cycle' },
      safeFacts({
        cycleId: 'entry-cycle',
        observedAt: '2026-09-01T13:00:00.000Z',
        hasOpenPosition: true,
      }),
    )
    expect(closing).toEqual({ _tag: 'Close', state: { _tag: 'Closing', remainingSessions: 3 } })
    expect(
      success(closing.state, safeFacts({ cycleId: 'entry-cycle', hasOpenPosition: true, closeSessionAdvanced: true })),
    ).toEqual({ _tag: 'Close', state: { _tag: 'Closing', remainingSessions: 2 } })
  })

  test('finalizes only when flat and completes only with the bound receipt', () => {
    const state = { _tag: 'Closing', remainingSessions: 2 } as const
    expect(success(state, safeFacts())).toEqual({ _tag: 'Finalize', state })
    expect(success(state, safeFacts({ receiptHash: 'a'.repeat(64) }))).toEqual({
      _tag: 'Complete',
      state: { _tag: 'Completed', receiptHash: 'a'.repeat(64) },
    })
    expect(
      success({ _tag: 'Completed', receiptHash: 'a'.repeat(64) }, safeFacts({ receiptHash: 'a'.repeat(64) })),
    ).toEqual({ _tag: 'Complete', state: { _tag: 'Completed', receiptHash: 'a'.repeat(64) } })
  })

  test('fails closed on every unsafe broker and recovery fact', () => {
    const failures: ReadonlyArray<[Partial<PaperEpisodeFacts['safety']>, PaperEpisodeFailure['_tag']]> = [
      [{ identityMatches: false }, 'IdentityDrift'],
      [{ restartUnambiguous: false }, 'RestartAmbiguous'],
      [{ unresolvedMutationCount: 1 }, 'UnknownMutation'],
      [{ reconciliationExact: false }, 'ReconciliationDiscrepancy'],
      [{ dataFresh: false }, 'StaleData'],
      [{ brokerRejected: true }, 'BrokerRejected'],
    ]
    for (const [safety, tag] of failures) {
      const result = decidePaperEpisode(
        { _tag: 'Pending' },
        safeFacts({ safety: { ...safeFacts().safety, ...safety } }),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe(tag)
    }
  })

  test('fails rather than opening a fourth close session', () => {
    const result = decidePaperEpisode(
      { _tag: 'Closing', remainingSessions: 1 },
      safeFacts({ cycleId: 'entry-cycle', hasOpenPosition: true, closeSessionAdvanced: true }),
    )
    expect(result).toEqual(Result.fail({ _tag: 'CloseWindowExhausted', cycleId: 'entry-cycle' }))
  })

  test('keeps the entry cycle active through holding and terminalizes only after close evidence', () => {
    const cutoff = '2026-09-01T13:00:00.000Z'
    expect(
      decidePaperEpisodeCycleTerminalization({
        closeOnly: false,
        observedAt: '2026-08-31T20:00:00.000Z',
        entryCutoffAt: cutoff,
        entryHasUnsuccessfulIntent: false,
      }),
    ).toEqual({ _tag: 'WaitForClose' })
    expect(
      decidePaperEpisodeCycleTerminalization({
        closeOnly: true,
        observedAt: cutoff,
        entryCutoffAt: cutoff,
        entryHasUnsuccessfulIntent: false,
      }),
    ).toEqual({ _tag: 'Complete' })
    expect(
      decidePaperEpisodeCycleTerminalization({
        closeOnly: true,
        observedAt: cutoff,
        entryCutoffAt: cutoff,
        entryHasUnsuccessfulIntent: true,
      }),
    ).toEqual({ _tag: 'Complete' })
    expect(
      decidePaperEpisodeCycleTerminalization({
        closeOnly: false,
        observedAt: cutoff,
        entryCutoffAt: cutoff,
        entryHasUnsuccessfulIntent: true,
      }),
    ).toEqual({ _tag: 'Block' })
  })

  test('keeps a terminal failure stable across restart', () => {
    const state = failedPaperEpisode({ _tag: 'BrokerRejected' })
    expect(success(state, safeFacts())).toEqual({ _tag: 'RemainFailed', state })
  })

  test('activates only from the exact OBSERVE source and resumes only the exact durable PAPER generation', () => {
    const common = {
      sourceGenerationHash: 'a'.repeat(64),
    }
    expect(
      decidePaperEpisodeAuthority({
        ...common,
        generationHash: common.sourceGenerationHash,
        maximum: 'OBSERVE',
        effective: 'OBSERVE',
        kill: 'CLEAR',
      }),
    ).toEqual(Result.succeed({ _tag: 'Activate' }))
    expect(
      decidePaperEpisodeAuthority({
        ...common,
        generationHash: 'b'.repeat(64),
        maximum: 'PAPER',
        effective: 'PAPER',
        kill: 'CLEAR',
      }),
    ).toEqual(Result.succeed({ _tag: 'Resume' }))
    expect(
      decidePaperEpisodeAuthority({
        ...common,
        generationHash: 'b'.repeat(64),
        maximum: 'PAPER',
        effective: 'OBSERVE',
        kill: 'ACTIVE',
      }),
    ).toEqual(Result.succeed({ _tag: 'Resume' }))
  })

  test('rejects source-generation drift instead of activating over unknown OBSERVE history', () => {
    const result = decidePaperEpisodeAuthority({
      generationHash: 'c'.repeat(64),
      sourceGenerationHash: 'a'.repeat(64),
      maximum: 'OBSERVE',
      effective: 'OBSERVE',
      kill: 'CLEAR',
    })
    expect(result).toEqual(Result.fail({ _tag: 'IdentityDrift' }))
  })

  test('accepts a close lease containing at most three complete market sessions', () => {
    const sessions = [
      { date: '2026-09-01', openAt: '2026-09-01T13:30:00.000Z', closeAt: '2026-09-01T20:00:00.000Z' },
      { date: '2026-09-02', openAt: '2026-09-02T13:30:00.000Z', closeAt: '2026-09-02T20:00:00.000Z' },
      { date: '2026-09-03', openAt: '2026-09-03T13:30:00.000Z', closeAt: '2026-09-03T20:00:00.000Z' },
    ]
    expect(
      validatePaperEpisodeCloseWindow({
        cutoffAt: sessions[0].openAt,
        expiresAt: sessions[2].closeAt,
        maximumCloseSessions: 3,
        sessions: [...sessions].reverse(),
      }),
    ).toEqual(Result.succeed(sessions))
  })

  test('rejects a partial, late-starting, or fourth-session close lease', () => {
    const sessions = [
      { date: '2026-09-01', openAt: '2026-09-01T13:30:00.000Z', closeAt: '2026-09-01T20:00:00.000Z' },
      { date: '2026-09-02', openAt: '2026-09-02T13:30:00.000Z', closeAt: '2026-09-02T20:00:00.000Z' },
      { date: '2026-09-03', openAt: '2026-09-03T13:30:00.000Z', closeAt: '2026-09-03T20:00:00.000Z' },
      { date: '2026-09-04', openAt: '2026-09-04T13:30:00.000Z', closeAt: '2026-09-04T20:00:00.000Z' },
    ]
    const invalid = [
      {
        cutoffAt: '2026-09-01T14:00:00.000Z',
        expiresAt: sessions[2].closeAt,
        maximumCloseSessions: 3,
        sessions,
      },
      {
        cutoffAt: sessions[0].openAt,
        expiresAt: '2026-09-03T19:00:00.000Z',
        maximumCloseSessions: 3,
        sessions,
      },
      {
        cutoffAt: sessions[0].openAt,
        expiresAt: sessions[3].closeAt,
        maximumCloseSessions: 3,
        sessions,
      },
    ]
    for (const input of invalid) {
      const result = validatePaperEpisodeCloseWindow(input)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe('InvalidCloseWindow')
    }
  })
})
