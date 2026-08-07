import { Result, Schema } from 'effect'

import { notionalMicros } from './execution-model'
import { Sha256Schema } from './schemas'

export const QualificationBindingSchema = Schema.Struct({
  runId: Sha256Schema,
  lockId: Sha256Schema,
  resultHash: Sha256Schema,
})
export type QualificationBinding = typeof QualificationBindingSchema.Type

export const QualifiedPaperGrantSchema = Schema.Struct({
  _tag: Schema.Literal('Qualified'),
  qualification: QualificationBindingSchema,
})
export const ResearchPaperGrantSchema = Schema.Struct({
  _tag: Schema.Literal('Research'),
  planHash: Sha256Schema,
})
export const PaperGrantSchema = Schema.Union([QualifiedPaperGrantSchema, ResearchPaperGrantSchema])
export type PaperGrant = typeof PaperGrantSchema.Type

export interface PaperEpisodeAllocationFacts {
  readonly accountEquityMicros: bigint
  readonly dailyTradedNotionalMicros: bigint
  readonly maxGrossExposureMicros: bigint
  readonly maxNetExposureMicros: bigint
  readonly maxDailyTradedNotionalMicros: bigint
  readonly maxAdverseSlippageBps: bigint
  readonly positions: readonly {
    readonly quantityMicros: string
    readonly symbol: string
  }[]
  readonly referencePriceMicros: Readonly<Record<string, string>>
}

export type PaperEpisodeAllocationFailure =
  | {
      readonly _tag: 'CurrentExposureExceedsRemainingTurnover'
      readonly currentReferenceGrossExposureMicros: bigint
      readonly remainingReferenceTurnoverMicros: bigint
    }
  | { readonly _tag: 'InvalidPositionReferenceNotional'; readonly cause: unknown; readonly symbol: string }
  | { readonly _tag: 'MissingPositionReferencePrice'; readonly symbol: string }

const nonNegative = (value: bigint): bigint => (value < 0n ? 0n : value)
const absolute = (value: bigint): bigint => (value < 0n ? -value : value)
const BASIS_POINTS = 10_000n

const currentReferenceGrossExposureMicros = (
  facts: PaperEpisodeAllocationFacts,
): Result.Result<bigint, PaperEpisodeAllocationFailure> =>
  facts.positions.reduce<Result.Result<bigint, PaperEpisodeAllocationFailure>>(
    (total, position) =>
      Result.flatMap(total, (current) => {
        const price = facts.referencePriceMicros[position.symbol]
        if (price === undefined) {
          return Result.fail({ _tag: 'MissingPositionReferencePrice', symbol: position.symbol })
        }
        return Result.mapError(
          Result.map(
            notionalMicros(absolute(BigInt(position.quantityMicros)), BigInt(price)),
            (notional) => current + notional,
          ),
          (cause): PaperEpisodeAllocationFailure => ({
            _tag: 'InvalidPositionReferenceNotional',
            cause,
            symbol: position.symbol,
          }),
        )
      }),
    Result.succeed(0n),
  )

/**
 * Bounds entry target construction by a sell-plus-buy turnover upper bound. Current reference gross exposure plus
 * target gross capital bounds every absolute target delta, including rotations; an infeasible current portfolio is
 * rejected before target planning instead of producing a risk-blocked authority transition.
 */
export const paperEpisodeAllocationCapitalMicros = (
  facts: PaperEpisodeAllocationFacts,
): Result.Result<bigint, PaperEpisodeAllocationFailure> => {
  const remainingDailyTurnover = nonNegative(facts.maxDailyTradedNotionalMicros - facts.dailyTradedNotionalMicros)
  const remainingReferenceTurnover =
    (remainingDailyTurnover * BASIS_POINTS) / (BASIS_POINTS + nonNegative(facts.maxAdverseSlippageBps))
  return Result.flatMap(currentReferenceGrossExposureMicros(facts), (currentReferenceGrossExposure) => {
    if (currentReferenceGrossExposure > remainingReferenceTurnover) {
      return Result.fail({
        _tag: 'CurrentExposureExceedsRemainingTurnover',
        currentReferenceGrossExposureMicros: currentReferenceGrossExposure,
        remainingReferenceTurnoverMicros: remainingReferenceTurnover,
      })
    }
    const referenceCapitalWithinTurnover = remainingReferenceTurnover - currentReferenceGrossExposure
    return Result.succeed(
      [
        facts.accountEquityMicros,
        facts.maxGrossExposureMicros,
        facts.maxNetExposureMicros,
        referenceCapitalWithinTurnover,
      ]
        .map(nonNegative)
        .reduce((minimum, value) => (value < minimum ? value : minimum)),
    )
  })
}

export const paperGrantKey = (grant: PaperGrant): string =>
  grant._tag === 'Qualified' ? grant.qualification.runId : grant.planHash

export type PersistedPaperGrantBinding =
  | {
      readonly schemaVersion: 'bayn.paper-authority-generation.v2'
      readonly qualificationRunId: string
      readonly qualificationLockId: string
      readonly qualificationResultHash: string
    }
  | {
      readonly schemaVersion: 'bayn.paper-authority-generation.v3'
      readonly grant: Extract<PaperGrant, { readonly _tag: 'Research' }>
    }

/** Projects legacy qualification-bound history into the episode grant without rewriting durable rows. */
export const paperGrantFromGeneration = (generation: PersistedPaperGrantBinding): PaperGrant =>
  generation.schemaVersion === 'bayn.paper-authority-generation.v3'
    ? generation.grant
    : {
        _tag: 'Qualified',
        qualification: {
          runId: generation.qualificationRunId,
          lockId: generation.qualificationLockId,
          resultHash: generation.qualificationResultHash,
        },
      }

export type PaperEpisodeFailure =
  | { readonly _tag: 'BrokerRejected' }
  | { readonly _tag: 'CloseWindowExhausted'; readonly cycleId: string }
  | { readonly _tag: 'IdentityDrift' }
  | { readonly _tag: 'InvalidCloseWindow'; readonly reason: string }
  | { readonly _tag: 'InvalidTransition'; readonly state: PaperEpisodeState['_tag']; readonly reason: string }
  | { readonly _tag: 'MissedEntryCutoff' }
  | { readonly _tag: 'ReconciliationDiscrepancy' }
  | { readonly _tag: 'RestartAmbiguous' }
  | { readonly _tag: 'StaleData' }
  | { readonly _tag: 'UnknownMutation'; readonly count: number }

export type PaperEpisodeState =
  | { readonly _tag: 'Pending' }
  | { readonly _tag: 'Entering'; readonly cycleId: string }
  | { readonly _tag: 'Holding'; readonly entryCycleId: string }
  | { readonly _tag: 'Closing'; readonly remainingSessions: number }
  | { readonly _tag: 'Completed'; readonly receiptHash: string }
  | { readonly _tag: 'Failed'; readonly reason: PaperEpisodeFailure }

export interface PaperEpisodeSafetyFacts {
  readonly brokerRejected: boolean
  readonly dataFresh: boolean
  readonly identityMatches: boolean
  readonly reconciliationExact: boolean
  readonly restartUnambiguous: boolean
  readonly unresolvedMutationCount: number
}

export interface PaperEpisodeFacts {
  readonly observedAt: string
  readonly entryCutoffAt: string
  readonly maximumCloseSessions: number
  readonly cycleId?: string
  readonly finalizedSnapshotAvailable: boolean
  readonly nonzeroTargetAvailable: boolean
  readonly entryFilled: boolean
  readonly hasOpenPosition: boolean
  readonly closeSessionAdvanced: boolean
  readonly receiptHash?: string
  readonly safety: PaperEpisodeSafetyFacts
}

export interface PaperEpisodeMarketSession {
  readonly date: string
  readonly openAt: string
  readonly closeAt: string
}

export interface PaperEpisodeAuthorityFacts {
  readonly generationHash: string
  readonly sourceGenerationHash: string
  readonly currentGenerationMatchesRequest: boolean
  readonly maximum: 'OBSERVE' | 'PAPER'
  readonly effective: 'OBSERVE' | 'PAPER'
  readonly kill: 'CLEAR' | 'ACTIVE'
  readonly reason?: string
}

export const paperEpisodeFailureRestrictionPrefix = 'PAPER autonomous cycle loop restricted effective authority:'

export type PaperEpisodeAuthorityDecision =
  | { readonly _tag: 'Activate' }
  | { readonly _tag: 'Rearm' }
  | { readonly _tag: 'Resume' }

export const decidePaperEpisodeAuthority = (
  facts: PaperEpisodeAuthorityFacts,
): Result.Result<PaperEpisodeAuthorityDecision, PaperEpisodeFailure> => {
  if (
    facts.maximum === 'OBSERVE' &&
    facts.effective === 'OBSERVE' &&
    facts.kill === 'CLEAR' &&
    facts.generationHash === facts.sourceGenerationHash
  ) {
    return Result.succeed({ _tag: 'Activate' })
  }
  if (
    facts.maximum === 'PAPER' &&
    facts.effective === 'PAPER' &&
    facts.kill === 'CLEAR' &&
    facts.currentGenerationMatchesRequest
  ) {
    return Result.succeed({ _tag: 'Resume' })
  }
  if (
    facts.maximum === 'PAPER' &&
    facts.effective === 'PAPER' &&
    facts.kill === 'CLEAR' &&
    !facts.currentGenerationMatchesRequest &&
    facts.generationHash !== facts.sourceGenerationHash
  ) {
    return Result.succeed({ _tag: 'Rearm' })
  }
  if (
    facts.maximum === 'PAPER' &&
    facts.effective === 'OBSERVE' &&
    facts.kill === 'ACTIVE' &&
    facts.generationHash !== facts.sourceGenerationHash &&
    facts.reason?.startsWith(paperEpisodeFailureRestrictionPrefix) === true
  ) {
    return Result.succeed({ _tag: 'Rearm' })
  }
  return Result.fail({ _tag: 'IdentityDrift' })
}

export const validatePaperEpisodeCloseWindow = (input: {
  readonly cutoffAt: string
  readonly expiresAt: string
  readonly maximumCloseSessions: number
  readonly sessions: readonly PaperEpisodeMarketSession[]
}): Result.Result<readonly PaperEpisodeMarketSession[], PaperEpisodeFailure> => {
  if (!Number.isSafeInteger(input.maximumCloseSessions) || input.maximumCloseSessions < 1) {
    return Result.fail({ _tag: 'InvalidCloseWindow', reason: 'maximum close sessions must be positive' })
  }
  if (input.cutoffAt >= input.expiresAt) {
    return Result.fail({ _tag: 'InvalidCloseWindow', reason: 'close expiry must follow the cutoff' })
  }
  const ordered = [...input.sessions].sort((left, right) => left.openAt.localeCompare(right.openAt))
  for (let index = 0; index < ordered.length; index += 1) {
    const session = ordered[index]
    const previous = ordered[index - 1]
    if (session === undefined || session.openAt >= session.closeAt) {
      return Result.fail({ _tag: 'InvalidCloseWindow', reason: 'market session interval is invalid' })
    }
    if (previous !== undefined && (session.date === previous.date || session.openAt <= previous.openAt)) {
      return Result.fail({ _tag: 'InvalidCloseWindow', reason: 'market sessions are not unique and ordered' })
    }
  }
  const closeSessions = ordered.filter(
    (session) => session.closeAt > input.cutoffAt && session.openAt < input.expiresAt,
  )
  if (closeSessions.length === 0) {
    return Result.fail({ _tag: 'InvalidCloseWindow', reason: 'close window contains no market session' })
  }
  if (closeSessions.length > input.maximumCloseSessions) {
    return Result.fail({ _tag: 'InvalidCloseWindow', reason: 'close window exceeds its market-session limit' })
  }
  if (closeSessions[0]?.openAt !== input.cutoffAt) {
    return Result.fail({ _tag: 'InvalidCloseWindow', reason: 'close cutoff must equal the first session open' })
  }
  if (closeSessions.some((session) => session.closeAt > input.expiresAt)) {
    return Result.fail({ _tag: 'InvalidCloseWindow', reason: 'close expiry truncates a market session' })
  }
  return Result.succeed(closeSessions)
}

export type PaperEpisodeDecision =
  | { readonly _tag: 'WaitForEntry'; readonly state: Extract<PaperEpisodeState, { readonly _tag: 'Pending' }> }
  | { readonly _tag: 'StartEntry'; readonly state: Extract<PaperEpisodeState, { readonly _tag: 'Pending' }> }
  | { readonly _tag: 'Enter'; readonly state: Extract<PaperEpisodeState, { readonly _tag: 'Entering' }> }
  | { readonly _tag: 'ContinueEntry'; readonly state: Extract<PaperEpisodeState, { readonly _tag: 'Entering' }> }
  | { readonly _tag: 'Hold'; readonly state: Extract<PaperEpisodeState, { readonly _tag: 'Holding' }> }
  | { readonly _tag: 'Close'; readonly state: Extract<PaperEpisodeState, { readonly _tag: 'Closing' }> }
  | { readonly _tag: 'Finalize'; readonly state: Extract<PaperEpisodeState, { readonly _tag: 'Closing' }> }
  | { readonly _tag: 'Complete'; readonly state: Extract<PaperEpisodeState, { readonly _tag: 'Completed' }> }
  | { readonly _tag: 'RemainFailed'; readonly state: Extract<PaperEpisodeState, { readonly _tag: 'Failed' }> }

export type PaperEpisodeCycleTerminalizationDecision =
  | { readonly _tag: 'WaitForClose' }
  | { readonly _tag: 'Block' }
  | { readonly _tag: 'Complete' }

export const decidePaperEpisodeCycleTerminalization = (input: {
  readonly closeOnly: boolean
  readonly observedAt: string
  readonly entryCutoffAt?: string
  readonly entryHasUnsuccessfulIntent: boolean
}): PaperEpisodeCycleTerminalizationDecision => {
  if (!input.closeOnly && input.entryCutoffAt !== undefined && input.observedAt < input.entryCutoffAt) {
    return { _tag: 'WaitForClose' }
  }
  if (!input.closeOnly && input.entryCutoffAt !== undefined && input.entryHasUnsuccessfulIntent) {
    return { _tag: 'Block' }
  }
  return { _tag: 'Complete' }
}

const invalid = (state: PaperEpisodeState, reason: string): Result.Result<never, PaperEpisodeFailure> =>
  Result.fail({ _tag: 'InvalidTransition', state: state._tag, reason })

const safetyFailure = (facts: PaperEpisodeSafetyFacts): PaperEpisodeFailure | undefined => {
  if (!facts.identityMatches) return { _tag: 'IdentityDrift' }
  if (!facts.restartUnambiguous) return { _tag: 'RestartAmbiguous' }
  if (facts.unresolvedMutationCount !== 0) {
    return { _tag: 'UnknownMutation', count: facts.unresolvedMutationCount }
  }
  if (!facts.reconciliationExact) return { _tag: 'ReconciliationDiscrepancy' }
  if (!facts.dataFresh) return { _tag: 'StaleData' }
  if (facts.brokerRejected) return { _tag: 'BrokerRejected' }
  return undefined
}

const closeDecision = (
  state: Extract<PaperEpisodeState, { readonly _tag: 'Closing' }>,
  facts: PaperEpisodeFacts,
): Result.Result<PaperEpisodeDecision, PaperEpisodeFailure> => {
  if (facts.receiptHash !== undefined) {
    return facts.hasOpenPosition
      ? invalid(state, 'a completed receipt cannot coexist with an open position')
      : Result.succeed({ _tag: 'Complete', state: { _tag: 'Completed', receiptHash: facts.receiptHash } })
  }
  if (!facts.hasOpenPosition) return Result.succeed({ _tag: 'Finalize', state })
  const remainingSessions = state.remainingSessions - (facts.closeSessionAdvanced ? 1 : 0)
  return remainingSessions <= 0
    ? Result.fail({ _tag: 'CloseWindowExhausted', cycleId: facts.cycleId ?? 'unknown' })
    : Result.succeed({ _tag: 'Close', state: { _tag: 'Closing', remainingSessions } })
}

/**
 * Total, I/O-free decision for one bounded sandbox PAPER episode. The caller derives facts from durable generation,
 * cycle, intent, broker, reconciliation, and receipt records, then interprets the returned action through existing
 * ports. No state is hidden in this module.
 */
export const decidePaperEpisode = (
  state: PaperEpisodeState,
  facts: PaperEpisodeFacts,
): Result.Result<PaperEpisodeDecision, PaperEpisodeFailure> => {
  if (!Number.isSafeInteger(facts.maximumCloseSessions) || facts.maximumCloseSessions < 1) {
    return invalid(state, 'maximumCloseSessions must be a positive safe integer')
  }
  const safety = safetyFailure(facts.safety)
  if (safety !== undefined) return Result.fail(safety)

  switch (state._tag) {
    case 'Pending':
      if (facts.receiptHash !== undefined) return invalid(state, 'a pending episode cannot already have a receipt')
      if (facts.cycleId !== undefined) {
        return Result.succeed({ _tag: 'Enter', state: { _tag: 'Entering', cycleId: facts.cycleId } })
      }
      if (facts.observedAt >= facts.entryCutoffAt) return Result.fail({ _tag: 'MissedEntryCutoff' })
      return facts.finalizedSnapshotAvailable && facts.nonzeroTargetAvailable
        ? Result.succeed({ _tag: 'StartEntry', state })
        : Result.succeed({ _tag: 'WaitForEntry', state })

    case 'Entering':
      if (facts.cycleId !== undefined && facts.cycleId !== state.cycleId) {
        return invalid(state, 'the durable entry cycle identity changed')
      }
      if (facts.entryFilled || facts.hasOpenPosition) {
        return Result.succeed({ _tag: 'Hold', state: { _tag: 'Holding', entryCycleId: state.cycleId } })
      }
      return facts.observedAt >= facts.entryCutoffAt
        ? Result.fail({ _tag: 'MissedEntryCutoff' })
        : Result.succeed({ _tag: 'ContinueEntry', state })

    case 'Holding':
      if (facts.cycleId !== undefined && facts.cycleId !== state.entryCycleId) {
        return invalid(state, 'the durable holding cycle identity changed')
      }
      if (!facts.hasOpenPosition) {
        return facts.receiptHash === undefined
          ? invalid(state, 'a held position disappeared before a terminal receipt')
          : Result.succeed({ _tag: 'Complete', state: { _tag: 'Completed', receiptHash: facts.receiptHash } })
      }
      return facts.observedAt < facts.entryCutoffAt
        ? Result.succeed({ _tag: 'Hold', state })
        : Result.succeed({
            _tag: 'Close',
            state: { _tag: 'Closing', remainingSessions: facts.maximumCloseSessions },
          })

    case 'Closing':
      return closeDecision(state, facts)

    case 'Completed':
      return facts.receiptHash === state.receiptHash && !facts.hasOpenPosition
        ? Result.succeed({ _tag: 'Complete', state })
        : invalid(state, 'completed episode evidence changed')

    case 'Failed':
      return Result.succeed({ _tag: 'RemainFailed', state })
  }
}

export const failedPaperEpisode = (
  reason: PaperEpisodeFailure,
): Extract<PaperEpisodeState, { readonly _tag: 'Failed' }> => ({ _tag: 'Failed', reason })
