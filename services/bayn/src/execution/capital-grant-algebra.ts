import { DateTime, pipe, Result } from 'effect'

import type { RuntimeBuildMetadata } from '../config'
import { Pipeable } from '../pipeable'
import {
  Authority,
  KillState,
  ReconciliationStatus,
  makeResearchCapitalGrantGenerationResult,
  type AuthorityState,
  type ResearchCapitalGrantGeneration,
  type ResearchCapitalGrantGenerationConstructionFailure,
  type ResearchCapitalGrantGenerationMaterial,
  type ResearchCapitalGrantProofBinding,
} from './contracts'
import { legacyAuthorityGenerationV3SchemaVersion } from './legacy-wire'

export interface AuthorityGenerationHistoryFacts {
  readonly generationHash: string
  readonly maximum: Authority
  readonly authorityVersion: string
  readonly activatedAt: Date
}

export interface ExactReconciliationFacts {
  readonly reconciliationId: string
  readonly accountId: string
  readonly contentHash: string
  readonly status: ReconciliationStatus
  readonly reconciledAt: Date
}

export interface MutationBaselineFacts {
  readonly unresolvedCount: number
  readonly latestMutationAt: Date | null
}

export interface DerivedResearchCapitalGrantGeneration {
  readonly current: AuthorityState
  readonly generation: ResearchCapitalGrantGeneration
  readonly reconciliation: ExactReconciliationFacts
}

type AuthorityBuildFacts = Pick<
  RuntimeBuildMetadata,
  'sourceRevision' | 'imageRepository' | 'imageDigest' | 'strategyBehaviorHash' | 'strategyParameterHash'
>

export interface ObserveGenerationRequest {
  readonly generationHash: string
  readonly maximum: Authority.Observe
  readonly preserveCyclePlanHash?: string
}

export type ObserveGenerationDecision =
  | {
      readonly _tag: 'InitializeObserveGeneration'
      readonly generationHash: string
      readonly maximum: Authority.Observe
    }
  | {
      readonly _tag: 'ReplayObserveGeneration'
      readonly current: AuthorityState
    }
  | {
      readonly _tag: 'RotateObserveGeneration'
      readonly current: AuthorityState
      readonly generationHash: string
      readonly maximum: Authority.Observe
      readonly authorityVersion: number
    }

export type CapitalGrantActivationDecision =
  | {
      readonly _tag: 'ActivateCapitalGrantGeneration'
      readonly current: AuthorityState
      readonly authorityVersion: number
    }
  | { readonly _tag: 'ReplayCapitalGrantGeneration'; readonly current: AuthorityState }

export type CapitalGrantAlgebraFailure =
  | { readonly _tag: 'ObserveMaximumRequired'; readonly maximum: Authority }
  | { readonly _tag: 'CurrentGenerationHistoryMissing'; readonly generationHash: string }
  | {
      readonly _tag: 'InvalidGenerationHistoryVersion'
      readonly generationHash: string
      readonly authorityVersion: string
    }
  | {
      readonly _tag: 'InvalidGenerationHistoryActivatedAt'
      readonly generationHash: string
      readonly activatedAt: Date
      readonly epochMillis: number
    }
  | {
      readonly _tag: 'CurrentGenerationHistoryMismatch'
      readonly currentGenerationHash: string
      readonly historyGenerationHash: string
      readonly currentMaximum: Authority
      readonly historyMaximum: Authority
      readonly currentVersion: number
      readonly historyVersion: number
      readonly currentUpdatedAt: string
      readonly historyActivatedAt: string
    }
  | {
      readonly _tag: 'AuthorityUpdateAfterObservation'
      readonly generationHash: string
      readonly updatedAt: Date
      readonly observedAt: Date
    }
  | {
      readonly _tag: 'AuthorityVersionExhausted'
      readonly generationHash: string
      readonly currentAuthorityVersion: number
    }
  | { readonly _tag: 'AuthorityGenerationAlreadyUsed'; readonly generationHash: string }
  | {
      readonly _tag: 'AuthorityMaximumConflict'
      readonly generationHash: string
      readonly requestedMaximum: Authority
      readonly durableMaximum: Authority
    }
  | {
      readonly _tag: 'CapitalGrantSourceAuthorityNotObserve'
      readonly generationHash: string
      readonly maximum: Authority
      readonly effective: Authority
    }
  | {
      readonly _tag: 'CapitalGrantPrepareGenerationMismatch'
      readonly currentGenerationHash: string
      readonly configuredGenerationHash: string
    }
  | {
      readonly _tag: 'ExactReconciliationUnavailable'
      readonly accountId: string
      readonly reconciliationId: string | undefined
      readonly reconciliationAccountId: string | undefined
      readonly status: ReconciliationStatus | undefined
    }
  | {
      readonly _tag: 'MutationCoverageIncomplete'
      readonly unresolvedCount: number
      readonly latestMutationAt: Date | null
      readonly reconciledAt: Date
    }
  | { readonly _tag: 'ResearchCapitalGrantGenerationDerivationFailed'; readonly cause: unknown }
  | {
      readonly _tag: 'ReconciliationNotFresh'
      readonly reconciledAt: Date
      readonly observedAt: Date
      readonly staleThresholdMs: number
    }
  | {
      readonly _tag: 'DurableCapitalGrantGenerationMismatch'
      readonly durableGenerationHash: string
      readonly configuredGenerationHash: string
    }
  | {
      readonly _tag: 'ResearchCapitalGrantGenerationReplayMismatch'
      readonly generationHash: string
      readonly expectedPreviousGenerationHash: string
    }
  | {
      readonly _tag: 'ResearchCapitalGrantGenerationRuntimeMismatch'
      readonly field:
        | 'accountId'
        | 'activationBuild'
        | 'brokerIdentityHash'
        | 'generationHash'
        | 'proofPlanHash'
        | 'strategy'
    }

export interface CapitalGrantFailureDetails {
  readonly failure: 'conflict' | 'decode' | 'invariant'
  readonly message: string
  readonly cause?: unknown
}

const fail = <A>(failure: CapitalGrantAlgebraFailure): Result.Result<A, CapitalGrantAlgebraFailure> =>
  Result.fail(failure)

export const validateObserveGenerationRequest = (input: {
  readonly generationHash: string
  readonly maximum: Authority
  readonly preserveCyclePlanHash?: string
}): Result.Result<ObserveGenerationRequest, CapitalGrantAlgebraFailure> =>
  input.maximum === Authority.Observe
    ? Result.succeed({
        generationHash: input.generationHash,
        maximum: Authority.Observe,
        ...(input.preserveCyclePlanHash === undefined ? {} : { preserveCyclePlanHash: input.preserveCyclePlanHash }),
      })
    : fail({ _tag: 'ObserveMaximumRequired', maximum: input.maximum })

export const nextAuthorityVersion = (current: {
  readonly generationHash: string
  readonly version: number
}): Result.Result<number, CapitalGrantAlgebraFailure> => {
  const authorityVersion = current.version + 1
  return Number.isSafeInteger(authorityVersion)
    ? Result.succeed(authorityVersion)
    : fail({
        _tag: 'AuthorityVersionExhausted',
        generationHash: current.generationHash,
        currentAuthorityVersion: current.version,
      })
}

const decideObserveGenerationDataFirst = (
  input: ObserveGenerationRequest,
  current: AuthorityState | undefined,
): Result.Result<ObserveGenerationDecision, CapitalGrantAlgebraFailure> => {
  if (current === undefined) {
    return Result.succeed({
      _tag: 'InitializeObserveGeneration',
      generationHash: input.generationHash,
      maximum: input.maximum,
    })
  }
  if (current.generationHash === input.generationHash) {
    if (current.maximum !== input.maximum) {
      return fail({
        _tag: 'AuthorityMaximumConflict',
        generationHash: input.generationHash,
        requestedMaximum: input.maximum,
        durableMaximum: current.maximum,
      })
    }
    return Result.succeed({ _tag: 'ReplayObserveGeneration', current })
  }
  return Result.map(
    nextAuthorityVersion(current),
    (authorityVersion): ObserveGenerationDecision => ({
      _tag: 'RotateObserveGeneration',
      current,
      generationHash: input.generationHash,
      maximum: input.maximum,
      authorityVersion,
    }),
  )
}

export const decideObserveGeneration = Pipeable.dual(2, decideObserveGenerationDataFirst)

const validateAuthorityObservationDataFirst = (
  current: AuthorityState,
  observedAt: Date,
): Result.Result<void, CapitalGrantAlgebraFailure> => {
  const updatedAt = DateTime.makeUnsafe(current.updatedAt)
  return DateTime.toEpochMillis(updatedAt) <= observedAt.getTime()
    ? Result.succeed(undefined)
    : fail({
        _tag: 'AuthorityUpdateAfterObservation',
        generationHash: current.generationHash,
        updatedAt: DateTime.toDateUtc(updatedAt),
        observedAt,
      })
}

export const validateAuthorityObservation = Pipeable.dual(2, validateAuthorityObservationDataFirst)

const validateCurrentGenerationHistoryDataFirst = <History extends AuthorityGenerationHistoryFacts>(
  current: AuthorityState,
  history: History | undefined,
): Result.Result<History, CapitalGrantAlgebraFailure> => {
  if (history === undefined) {
    return fail({ _tag: 'CurrentGenerationHistoryMissing', generationHash: current.generationHash })
  }
  const historyVersion = Number(history.authorityVersion)
  if (!Number.isSafeInteger(historyVersion) || historyVersion <= 0) {
    return fail({
      _tag: 'InvalidGenerationHistoryVersion',
      generationHash: history.generationHash,
      authorityVersion: history.authorityVersion,
    })
  }
  const historyActivatedAtEpochMillis = history.activatedAt.getTime()
  if (!Number.isFinite(historyActivatedAtEpochMillis)) {
    return fail({
      _tag: 'InvalidGenerationHistoryActivatedAt',
      generationHash: history.generationHash,
      activatedAt: history.activatedAt,
      epochMillis: historyActivatedAtEpochMillis,
    })
  }
  const historyActivatedAt = DateTime.formatIso(DateTime.makeUnsafe(historyActivatedAtEpochMillis))
  if (
    history.generationHash !== current.generationHash ||
    history.maximum !== current.maximum ||
    historyVersion > current.version ||
    historyActivatedAt > current.updatedAt
  ) {
    return fail({
      _tag: 'CurrentGenerationHistoryMismatch',
      currentGenerationHash: current.generationHash,
      historyGenerationHash: history.generationHash,
      currentMaximum: current.maximum,
      historyMaximum: history.maximum,
      currentVersion: current.version,
      historyVersion,
      currentUpdatedAt: current.updatedAt,
      historyActivatedAt,
    })
  }
  return Result.succeed(history)
}

export const validateCurrentGenerationHistory = Pipeable.generic<
  <History extends AuthorityGenerationHistoryFacts>(
    history: History | undefined,
  ) => (current: AuthorityState) => Result.Result<History, CapitalGrantAlgebraFailure>,
  typeof validateCurrentGenerationHistoryDataFirst
>(2, validateCurrentGenerationHistoryDataFirst)

const requireUnusedAuthorityGenerationDataFirst = (
  generationHash: string,
  existing: AuthorityGenerationHistoryFacts | undefined,
): Result.Result<void, CapitalGrantAlgebraFailure> =>
  existing === undefined ? Result.succeed(undefined) : fail({ _tag: 'AuthorityGenerationAlreadyUsed', generationHash })

export const requireUnusedAuthorityGeneration = Pipeable.dual(2, requireUnusedAuthorityGenerationDataFirst)

export const validateCapitalGrantSourceAuthority = (
  current: AuthorityState,
): Result.Result<void, CapitalGrantAlgebraFailure> =>
  current.maximum === Authority.Observe && current.effective === Authority.Observe
    ? Result.succeed(undefined)
    : fail({
        _tag: 'CapitalGrantSourceAuthorityNotObserve',
        generationHash: current.generationHash,
        maximum: current.maximum,
        effective: current.effective,
      })

const validateCapitalGrantPrepareGenerationDataFirst = (
  current: AuthorityState,
  binding: { readonly configuredGenerationHash: string },
): Result.Result<void, CapitalGrantAlgebraFailure> =>
  current.generationHash === binding.configuredGenerationHash
    ? Result.succeed(undefined)
    : fail({
        _tag: 'CapitalGrantPrepareGenerationMismatch',
        currentGenerationHash: current.generationHash,
        configuredGenerationHash: binding.configuredGenerationHash,
      })

export const validateCapitalGrantPrepareGeneration = Pipeable.dual(2, validateCapitalGrantPrepareGenerationDataFirst)

const validateLatestExactReconciliationDataFirst = (
  reconciliation: ExactReconciliationFacts | undefined,
  accountId: string,
): Result.Result<ExactReconciliationFacts, CapitalGrantAlgebraFailure> => {
  if (
    reconciliation === undefined ||
    reconciliation.accountId !== accountId ||
    reconciliation.status !== ReconciliationStatus.Exact
  ) {
    return fail({
      _tag: 'ExactReconciliationUnavailable',
      accountId,
      reconciliationId: reconciliation?.reconciliationId,
      reconciliationAccountId: reconciliation?.accountId,
      status: reconciliation?.status,
    })
  }
  return Result.succeed(reconciliation)
}

export const validateLatestExactReconciliation = Pipeable.dual(2, validateLatestExactReconciliationDataFirst)

const validateMutationCoverageDataFirst = (
  baseline: MutationBaselineFacts,
  reconciliation: ExactReconciliationFacts,
): Result.Result<void, CapitalGrantAlgebraFailure> =>
  baseline.unresolvedCount === 0 &&
  (baseline.latestMutationAt === null || baseline.latestMutationAt.getTime() <= reconciliation.reconciledAt.getTime())
    ? Result.succeed(undefined)
    : fail({
        _tag: 'MutationCoverageIncomplete',
        unresolvedCount: baseline.unresolvedCount,
        latestMutationAt: baseline.latestMutationAt,
        reconciledAt: reconciliation.reconciledAt,
      })

export const validateMutationCoverage = Pipeable.dual(2, validateMutationCoverageDataFirst)

const researchRuntimeMismatch = (
  field: Extract<
    CapitalGrantAlgebraFailure,
    { readonly _tag: 'ResearchCapitalGrantGenerationRuntimeMismatch' }
  >['field'],
): Result.Result<never, CapitalGrantAlgebraFailure> =>
  Result.fail({ _tag: 'ResearchCapitalGrantGenerationRuntimeMismatch', field })

export const validateResearchCapitalGrantProof = (input: {
  readonly proof: ResearchCapitalGrantProofBinding
  readonly sourceGenerationHash: string
  readonly accountId: string
  readonly brokerIdentityHash: string
  readonly build: AuthorityBuildFacts
}): Result.Result<void, CapitalGrantAlgebraFailure> => {
  const { proof, build } = input
  if (proof.accountId !== input.accountId) return researchRuntimeMismatch('accountId')
  if (proof.brokerIdentityHash !== input.brokerIdentityHash) return researchRuntimeMismatch('brokerIdentityHash')
  if (proof.proofPlanHash !== proof.grant.planHash) return researchRuntimeMismatch('proofPlanHash')
  if (
    proof.activationSourceRevision !== build.sourceRevision ||
    proof.activationImageRepository !== build.imageRepository ||
    proof.activationImageDigest !== build.imageDigest
  ) {
    return researchRuntimeMismatch('activationBuild')
  }
  if (
    proof.strategyBehaviorHash !== build.strategyBehaviorHash ||
    proof.strategyParameterHash !== build.strategyParameterHash
  ) {
    return researchRuntimeMismatch('strategy')
  }
  return /^[0-9a-f]{64}$/.test(input.sourceGenerationHash)
    ? Result.succeed(undefined)
    : researchRuntimeMismatch('generationHash')
}

const researchCapitalGrantGenerationMaterial = (input: {
  readonly current: AuthorityState
  readonly proof: ResearchCapitalGrantProofBinding
  readonly reconciliation: ExactReconciliationFacts
}): ResearchCapitalGrantGenerationMaterial => ({
  schemaVersion: legacyAuthorityGenerationV3SchemaVersion,
  maximum: Authority.Execution,
  previousGenerationHash: input.current.generationHash,
  grant: input.proof.grant,
  activationSourceRevision: input.proof.activationSourceRevision,
  activationImageRepository: input.proof.activationImageRepository,
  activationImageDigest: input.proof.activationImageDigest,
  strategyName: input.proof.strategyName,
  strategyBehaviorHash: input.proof.strategyBehaviorHash,
  strategyParameterHash: input.proof.strategyParameterHash,
  strategyParameterSchemaVersion: input.proof.strategyParameterSchemaVersion,
  strategyProtocolHash: input.proof.strategyProtocolHash,
  accountId: input.proof.accountId,
  brokerIdentityHash: input.proof.brokerIdentityHash,
  riskPolicyHash: input.proof.riskPolicyHash,
  proofPlanHash: input.proof.proofPlanHash,
  reconciliationId: input.reconciliation.reconciliationId,
  reconciliationContentHash: input.reconciliation.contentHash,
})

export const deriveResearchCapitalGrantGeneration = (input: {
  readonly current: AuthorityState
  readonly proof: ResearchCapitalGrantProofBinding
  readonly reconciliation: ExactReconciliationFacts
}): Result.Result<DerivedResearchCapitalGrantGeneration, CapitalGrantAlgebraFailure> =>
  pipe(
    makeResearchCapitalGrantGenerationResult(researchCapitalGrantGenerationMaterial(input)),
    Result.mapError(
      (cause: ResearchCapitalGrantGenerationConstructionFailure): CapitalGrantAlgebraFailure => ({
        _tag: 'ResearchCapitalGrantGenerationDerivationFailed',
        cause,
      }),
    ),
    Result.map((generation) => ({ current: input.current, generation, reconciliation: input.reconciliation })),
  )

const validateResearchCapitalGrantGenerationReplayDataFirst = (
  stored: ResearchCapitalGrantGeneration,
  proof: ResearchCapitalGrantProofBinding,
  expectedPreviousGenerationHash: string,
): Result.Result<void, CapitalGrantAlgebraFailure> =>
  stored.previousGenerationHash === expectedPreviousGenerationHash &&
  stored.grant.planHash === proof.grant.planHash &&
  stored.activationSourceRevision === proof.activationSourceRevision &&
  stored.activationImageRepository === proof.activationImageRepository &&
  stored.activationImageDigest === proof.activationImageDigest &&
  stored.strategyName === proof.strategyName &&
  stored.strategyBehaviorHash === proof.strategyBehaviorHash &&
  stored.strategyParameterHash === proof.strategyParameterHash &&
  stored.strategyParameterSchemaVersion === proof.strategyParameterSchemaVersion &&
  stored.strategyProtocolHash === proof.strategyProtocolHash &&
  stored.accountId === proof.accountId &&
  stored.brokerIdentityHash === proof.brokerIdentityHash &&
  stored.riskPolicyHash === proof.riskPolicyHash &&
  stored.proofPlanHash === proof.proofPlanHash
    ? Result.succeed(undefined)
    : fail({
        _tag: 'ResearchCapitalGrantGenerationReplayMismatch',
        generationHash: stored.generationHash,
        expectedPreviousGenerationHash,
      })

export const validateResearchCapitalGrantGenerationReplay = Pipeable.dual(
  3,
  validateResearchCapitalGrantGenerationReplayDataFirst,
)

const validateCapitalGrantGenerationFreshnessDataFirst = (
  reconciliation: ExactReconciliationFacts,
  observedAt: Date,
  staleThresholdMs: number,
): Result.Result<Date, CapitalGrantAlgebraFailure> =>
  reconciliation.reconciledAt.getTime() <= observedAt.getTime() &&
  observedAt.getTime() - reconciliation.reconciledAt.getTime() < staleThresholdMs
    ? Result.succeed(observedAt)
    : fail({
        _tag: 'ReconciliationNotFresh',
        reconciledAt: reconciliation.reconciledAt,
        observedAt,
        staleThresholdMs,
      })

export const validateCapitalGrantGenerationFreshness = Pipeable.dual(
  3,
  validateCapitalGrantGenerationFreshnessDataFirst,
)

const decideCapitalGrantActivationDataFirst = (
  current: AuthorityState,
  binding: { readonly configuredGenerationHash: string },
): Result.Result<CapitalGrantActivationDecision, CapitalGrantAlgebraFailure> => {
  if (current.maximum !== Authority.Execution) {
    return Result.map(
      nextAuthorityVersion(current),
      (authorityVersion): CapitalGrantActivationDecision => ({
        _tag: 'ActivateCapitalGrantGeneration',
        current,
        authorityVersion,
      }),
    )
  }
  return current.generationHash === binding.configuredGenerationHash
    ? Result.succeed({ _tag: 'ReplayCapitalGrantGeneration', current })
    : fail({
        _tag: 'DurableCapitalGrantGenerationMismatch',
        durableGenerationHash: current.generationHash,
        configuredGenerationHash: binding.configuredGenerationHash,
      })
}

export const decideCapitalGrantActivation = Pipeable.dual(2, decideCapitalGrantActivationDataFirst)

export const capitalGrantEffectiveAuthority = (kill: KillState): Authority =>
  kill === KillState.Active ? Authority.Observe : Authority.Execution

export const capitalGrantFailureDetails = (failure: CapitalGrantAlgebraFailure): CapitalGrantFailureDetails => {
  switch (failure._tag) {
    case 'ObserveMaximumRequired':
      return { failure: 'invariant', message: 'authority initialization requires an OBSERVE maximum' }
    case 'CurrentGenerationHistoryMissing':
      return { failure: 'invariant', message: 'current authority generation lacks immutable history' }
    case 'InvalidGenerationHistoryVersion':
      return { failure: 'invariant', message: 'authority generation history version is not a safe positive integer' }
    case 'InvalidGenerationHistoryActivatedAt':
      return {
        failure: 'invariant',
        message: 'current authority generation history differs from state',
        cause: failure,
      }
    case 'CurrentGenerationHistoryMismatch':
      return { failure: 'invariant', message: 'current authority generation history differs from state' }
    case 'AuthorityUpdateAfterObservation':
      return { failure: 'invariant', message: 'durable authority update follows its database observation time' }
    case 'AuthorityVersionExhausted':
      return { failure: 'invariant', message: 'durable authority version is not a safe positive integer' }
    case 'AuthorityGenerationAlreadyUsed':
      return { failure: 'conflict', message: 'authority generation hash was already used' }
    case 'AuthorityMaximumConflict':
      return { failure: 'conflict', message: 'authority generation maximum conflicts with durable state' }
    case 'CapitalGrantSourceAuthorityNotObserve':
      return { failure: 'invariant', message: 'capital grant generation requires current OBSERVE authority' }
    case 'CapitalGrantPrepareGenerationMismatch':
      return { failure: 'invariant', message: 'capital grant source differs from the configured OBSERVE generation' }
    case 'ExactReconciliationUnavailable':
    case 'ReconciliationNotFresh':
      return {
        failure: 'invariant',
        message: 'capital grant generation requires the latest fresh exact account reconciliation',
      }
    case 'MutationCoverageIncomplete':
      return {
        failure: 'invariant',
        message: 'capital grant generation requires zero unresolved mutations covered by reconciliation',
      }
    case 'ResearchCapitalGrantGenerationDerivationFailed':
      return {
        failure: 'decode',
        message: 'derived research capital grant generation is invalid',
        cause: failure.cause,
      }
    case 'DurableCapitalGrantGenerationMismatch':
      return { failure: 'conflict', message: 'durable capital grant generation differs from deterministic replay' }
    case 'ResearchCapitalGrantGenerationReplayMismatch':
      return {
        failure: 'conflict',
        message: 'research capital grant generation history differs from deterministic replay',
      }
    case 'ResearchCapitalGrantGenerationRuntimeMismatch':
      return {
        failure: 'invariant',
        message: `research capital grant generation ${failure.field} binding differs from the current runtime`,
      }
  }
}
