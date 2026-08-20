import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  decideExecutionMandateAuthority,
  decideExecutionMandateCycleTerminalization,
  constrainExecutionTargetAllocationCapitalMicros,
  executionMandateAllocationCapitalMicros,
  executionMandateFailureRestrictionPrefix,
  isExecutionMandateFailureRestriction,
  capitalGrantFromLegacyGeneration,
  capitalGrantKey,
  validateExecutionMandateCloseWindow,
} from './mandate'

describe('executionMandateAllocationCapitalMicros', () => {
  test('selects the smallest account, exposure, and remaining-turnover bound', () => {
    const common = {
      accountEquityMicros: 100_000_000_000n,
      dailyTradedNotionalMicros: 0n,
      maxGrossExposureMicros: 1_000_000_000n,
      maxNetExposureMicros: 1_000_000_000n,
      maxDailyTradedNotionalMicros: 1_000_000_000n,
      maxAdverseSlippageBps: 0n,
      positions: [],
      referencePriceMicros: {},
    }

    expect(Result.getOrThrow(executionMandateAllocationCapitalMicros(common))).toBe(1_000_000_000n)
    expect(
      Result.getOrThrow(
        executionMandateAllocationCapitalMicros({ ...common, dailyTradedNotionalMicros: 750_000_000n }),
      ),
    ).toBe(250_000_000n)
    expect(
      Result.getOrThrow(executionMandateAllocationCapitalMicros({ ...common, accountEquityMicros: 200_000_000n })),
    ).toBe(200_000_000n)
    expect(
      Result.getOrThrow(
        executionMandateAllocationCapitalMicros({ ...common, dailyTradedNotionalMicros: 1_000_000_001n }),
      ),
    ).toBe(0n)
    expect(Result.getOrThrow(executionMandateAllocationCapitalMicros({ ...common, maxAdverseSlippageBps: 10n }))).toBe(
      999_000_999n,
    )
  })

  test('bounds both sides of a rebalance and rejects exposure that cannot fit the remaining turnover', () => {
    const common = {
      accountEquityMicros: 100_000_000_000n,
      dailyTradedNotionalMicros: 750_000_000n,
      maxGrossExposureMicros: 1_000_000_000n,
      maxNetExposureMicros: 1_000_000_000n,
      maxDailyTradedNotionalMicros: 1_000_000_000n,
      maxAdverseSlippageBps: 0n,
      referencePriceMicros: { SPY: '100000000' },
    }
    const scalable = Result.getOrThrow(
      executionMandateAllocationCapitalMicros({
        ...common,
        positions: [{ symbol: 'SPY', quantityMicros: '1000000' }],
      }),
    )
    const rejected = executionMandateAllocationCapitalMicros({
      ...common,
      positions: [{ symbol: 'SPY', quantityMicros: '10000000' }],
    })

    expect(scalable).toBe(150_000_000n)
    expect(rejected).toEqual(
      Result.fail({
        _tag: 'CurrentExposureExceedsRemainingTurnover',
        currentReferenceGrossExposureMicros: 1_000_000_000n,
        remainingReferenceTurnoverMicros: 250_000_000n,
      }),
    )
  })

  test('caps portfolio capital before planning so each target fits order and symbol limits', () => {
    expect(
      Result.getOrThrow(
        constrainExecutionTargetAllocationCapitalMicros({
          allocationCapitalMicros: 100_000_000_000n,
          maxOrderNotionalMicros: 40_000_000_000n,
          maxSymbolExposureMicros: 50_000_000_000n,
          targetWeights: { AMD: 0.5, NVDA: 0.5 },
        }),
      ),
    ).toBe(80_000_000_000n)
    expect(
      Result.isFailure(
        constrainExecutionTargetAllocationCapitalMicros({
          allocationCapitalMicros: 100_000_000_000n,
          maxOrderNotionalMicros: 40_000_000_000n,
          maxSymbolExposureMicros: 40_000_000_000n,
          targetWeights: { AMD: Number.NaN },
        }),
      ),
    ).toBe(true)
  })
})

describe('execution mandate decisions', () => {
  test('recognizes only canonical and exact legacy system failure restrictions', () => {
    const cycleId = 'a'.repeat(64)
    const intentId = 'b'.repeat(64)

    expect(
      isExecutionMandateFailureRestriction(
        `${executionMandateFailureRestrictionPrefix} bound cycle blocked: BLOCKED_RISK`,
      ),
    ).toBe(true)
    expect(
      isExecutionMandateFailureRestriction(
        'PAPER autonomous cycle loop restricted effective authority: bound cycle blocked: BLOCKED_RISK',
      ),
    ).toBe(true)
    expect(
      isExecutionMandateFailureRestriction(
        `bound PAPER cycle ${cycleId} restricted effective authority: intent ${intentId} submit settled denied`,
      ),
    ).toBe(true)
    expect(
      isExecutionMandateFailureRestriction(
        `bound PAPER cycle ${cycleId} restricted effective authority: intent ${intentId} ended REJECTED`,
      ),
    ).toBe(true)
    expect(isExecutionMandateFailureRestriction('operator requested PAPER stop')).toBe(false)
    expect(
      isExecutionMandateFailureRestriction(
        `bound PAPER cycle ${cycleId} restricted effective authority: intent ${intentId} ended FILLED`,
      ),
    ).toBe(false)
    expect(
      isExecutionMandateFailureRestriction(
        `bound PAPER cycle ${cycleId.slice(1)} restricted effective authority: intent ${intentId} submit settled denied`,
      ),
    ).toBe(false)
  })

  test('adapts legacy qualification history and research history to one grant boundary', () => {
    const qualified = capitalGrantFromLegacyGeneration({
      schemaVersion: 'bayn.paper-authority-generation.v2',
      qualificationRunId: 'a'.repeat(64),
      qualificationLockId: 'b'.repeat(64),
      qualificationResultHash: 'c'.repeat(64),
    })
    const research = capitalGrantFromLegacyGeneration({
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
    expect(capitalGrantKey(qualified)).toBe('a'.repeat(64))
    expect(capitalGrantKey(research)).toBe('d'.repeat(64))
  })

  test('keeps the entry cycle active through holding and terminalizes only after close evidence', () => {
    const cutoff = '2026-09-01T13:00:00.000Z'
    expect(
      decideExecutionMandateCycleTerminalization({
        closeOnly: false,
        observedAt: '2026-08-31T20:00:00.000Z',
        entryCutoffAt: cutoff,
        entryHasUnsuccessfulIntent: false,
      }),
    ).toEqual({ _tag: 'WaitForClose' })
    expect(
      decideExecutionMandateCycleTerminalization({
        closeOnly: true,
        observedAt: cutoff,
        entryCutoffAt: cutoff,
        entryHasUnsuccessfulIntent: false,
      }),
    ).toEqual({ _tag: 'Complete' })
    expect(
      decideExecutionMandateCycleTerminalization({
        closeOnly: true,
        observedAt: cutoff,
        entryCutoffAt: cutoff,
        entryHasUnsuccessfulIntent: true,
      }),
    ).toEqual({ _tag: 'Complete' })
    expect(
      decideExecutionMandateCycleTerminalization({
        closeOnly: false,
        observedAt: cutoff,
        entryCutoffAt: cutoff,
        entryHasUnsuccessfulIntent: true,
      }),
    ).toEqual({ _tag: 'Block' })
  })

  test('activates, rearms, and resumes only from their exact durable authority states', () => {
    const common = {
      sourceGenerationHash: 'a'.repeat(64),
      currentGenerationMatchesRequest: false,
    }
    expect(
      decideExecutionMandateAuthority({
        ...common,
        generationHash: common.sourceGenerationHash,
        maximum: 'OBSERVE',
        effective: 'OBSERVE',
        kill: 'CLEAR',
      }),
    ).toEqual(Result.succeed({ _tag: 'Activate' }))
    expect(
      decideExecutionMandateAuthority({
        ...common,
        generationHash: 'b'.repeat(64),
        maximum: 'PAPER',
        effective: 'PAPER',
        kill: 'CLEAR',
        currentGenerationMatchesRequest: true,
      }),
    ).toEqual(Result.succeed({ _tag: 'Resume' }))
    expect(
      decideExecutionMandateAuthority({
        ...common,
        generationHash: 'b'.repeat(64),
        maximum: 'PAPER',
        effective: 'OBSERVE',
        kill: 'ACTIVE',
        reason: 'PAPER autonomous cycle loop restricted effective authority: build-decision failed',
      }),
    ).toEqual(Result.succeed({ _tag: 'Rearm' }))
    expect(
      decideExecutionMandateAuthority({
        ...common,
        generationHash: 'b'.repeat(64),
        maximum: 'PAPER',
        effective: 'OBSERVE',
        kill: 'ACTIVE',
        currentGenerationMatchesRequest: true,
        reason: 'PAPER autonomous cycle loop restricted effective authority: build-decision failed',
      }),
    ).toEqual(Result.succeed({ _tag: 'ResumeRestricted' }))
    expect(
      decideExecutionMandateAuthority({
        ...common,
        generationHash: 'b'.repeat(64),
        maximum: 'PAPER',
        effective: 'OBSERVE',
        kill: 'ACTIVE',
        currentGenerationMatchesRequest: true,
        reason: `bound PAPER cycle ${'c'.repeat(64)} restricted effective authority: intent ${'d'.repeat(64)} submit settled denied`,
      }),
    ).toEqual(Result.succeed({ _tag: 'ResumeRestricted' }))
    expect(
      decideExecutionMandateAuthority({
        ...common,
        generationHash: 'c'.repeat(64),
        maximum: 'PAPER',
        effective: 'PAPER',
        kill: 'CLEAR',
      }),
    ).toEqual(Result.succeed({ _tag: 'Rearm' }))
  })

  test('does not rearm an operator kill, an unchanged source generation, or unknown authority state', () => {
    const common = {
      generationHash: 'b'.repeat(64),
      sourceGenerationHash: 'a'.repeat(64),
      maximum: 'PAPER' as const,
      effective: 'OBSERVE' as const,
      kill: 'ACTIVE' as const,
      currentGenerationMatchesRequest: false,
    }
    expect(decideExecutionMandateAuthority({ ...common, reason: 'operator kill' })).toEqual(
      Result.fail({ _tag: 'IdentityDrift' }),
    )
    expect(
      decideExecutionMandateAuthority({
        ...common,
        sourceGenerationHash: common.generationHash,
        reason: 'PAPER autonomous cycle loop restricted effective authority: build-decision failed',
      }),
    ).toEqual(Result.fail({ _tag: 'IdentityDrift' }))
    expect(
      decideExecutionMandateAuthority({
        ...common,
        sourceGenerationHash: common.generationHash,
        maximum: 'PAPER',
        effective: 'PAPER',
        kill: 'CLEAR',
      }),
    ).toEqual(Result.fail({ _tag: 'IdentityDrift' }))
    expect(decideExecutionMandateAuthority(common)).toEqual(Result.fail({ _tag: 'IdentityDrift' }))
  })

  test('rejects source-generation drift instead of activating over unknown OBSERVE history', () => {
    const result = decideExecutionMandateAuthority({
      generationHash: 'c'.repeat(64),
      sourceGenerationHash: 'a'.repeat(64),
      maximum: 'OBSERVE',
      effective: 'OBSERVE',
      kill: 'CLEAR',
      currentGenerationMatchesRequest: false,
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
      validateExecutionMandateCloseWindow({
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
      const result = validateExecutionMandateCloseWindow(input)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe('InvalidCloseWindow')
    }
  })
})
