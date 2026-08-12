import { Result, Schema } from 'effect'

import { notionalMicros } from './execution-model'
import { Sha256Schema } from './schemas'

export const QualificationBindingSchema = Schema.Struct({
  runId: Sha256Schema,
  lockId: Sha256Schema,
  resultHash: Sha256Schema,
})
export type QualificationBinding = typeof QualificationBindingSchema.Type

export const QualifiedPaperGrantSchema = Schema.TaggedStruct('Qualified', {
  qualification: QualificationBindingSchema,
})
export const ResearchPaperGrantSchema = Schema.TaggedStruct('Research', {
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
  | { readonly _tag: 'IdentityDrift' }
  | { readonly _tag: 'InvalidCloseWindow'; readonly reason: string }

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
export const legacyPaperEpisodeFailureRestrictionPattern =
  '^bound PAPER cycle [0-9a-f]{64} restricted effective authority: intent [0-9a-f]{64} (submit settled (denied|rejected)|ended (BLOCKED|CANCELED|EXPIRED|REJECTED|without outcome))$'
const legacyPaperEpisodeFailureRestriction = new RegExp(legacyPaperEpisodeFailureRestrictionPattern)

/** Accepts only system-authored failure restrictions; operator kills and malformed legacy reasons stay fail-closed. */
export const isPaperEpisodeFailureRestriction = (reason: string | undefined): boolean =>
  reason?.startsWith(paperEpisodeFailureRestrictionPrefix) === true ||
  (reason !== undefined && legacyPaperEpisodeFailureRestriction.test(reason))

export const paperEpisodeCompletedRestrictionReason =
  'PAPER episode restricted effective authority: flat exact receipt finalized'
export const paperActivationExpiredRestrictionReason =
  'PAPER activation lease restricted effective authority: immutable activation request expired'

export type PaperEpisodeAuthorityDecision =
  | { readonly _tag: 'Activate' }
  | { readonly _tag: 'Rearm' }
  | { readonly _tag: 'Resume' }
  | { readonly _tag: 'ResumeRestricted' }

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
    isPaperEpisodeFailureRestriction(facts.reason)
  ) {
    return Result.succeed({ _tag: facts.currentGenerationMatchesRequest ? 'ResumeRestricted' : 'Rearm' })
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
