import { Result } from 'effect'

import type { RuntimeBuildMetadata } from '../config'
import { makeStrategyProtocolHash } from '../contracts'
import { canonicalHashV1 } from '../hash'
import {
  Authority,
  KillState,
  ReconciliationStatus,
  makePaperAuthorityGeneration,
  type AuthorityState,
  type PaperAuthorityGeneration,
  type PaperAuthorityProofBinding,
} from '../paper'
import type { QualificationLock, QualificationResult } from '../qualification'

export interface AuthorityGenerationHistoryFacts {
  readonly generationHash: string
  readonly maximum: Authority
  readonly authorityVersion: string
  readonly activatedAt: Date
}

export interface PaperGenerationRuntimeBinding {
  readonly accountId: string
  readonly configuredGenerationHash: string
  readonly qualificationRunId: string
}

export interface PaperGenerationRuntimeFacts {
  readonly maximumAuthority: Authority
  readonly alpaca:
    | {
        readonly accountId: string
        readonly authorityGenerationHash: string
      }
    | undefined
  readonly qualificationRunId: string | undefined
}

export interface PaperGenerationEvidenceFacts {
  readonly lock: QualificationLock
  readonly result: QualificationResult
  readonly runStatus: 'WRITING' | 'COMPLETE'
  readonly expectedArtifactCount: number
  readonly expectedEventCount: number
  readonly expectedGateCount: number
  readonly artifactCount: number
  readonly eventCount: number
  readonly gateCount: number
  readonly statusCount: number
  readonly writingStatusCount: number
  readonly completeStatusCount: number
  readonly writingDetail: unknown
  readonly completeDetail: unknown
  readonly protocolSchemaVersion: 'bayn.risk-balanced-trend.protocol.v2' | 'bayn.risk-balanced-trend.protocol.v3'
  readonly strategyName: 'risk-balanced-trend'
  readonly behaviorHash: string
  readonly parameterHash: string
  readonly parameters: unknown
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

export interface DerivedPaperGeneration {
  readonly current: AuthorityState
  readonly generation: PaperAuthorityGeneration
  readonly reconciliation: ExactReconciliationFacts
}

type AuthorityBuildFacts = Pick<
  RuntimeBuildMetadata,
  'sourceRevision' | 'imageRepository' | 'imageDigest' | 'strategyBehaviorHash' | 'strategyParameterHash'
>

export interface ObserveGenerationRequest {
  readonly generationHash: string
  readonly maximum: Authority.Observe
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

export type PaperActivationDecision =
  | {
      readonly _tag: 'ActivatePaperGeneration'
      readonly current: AuthorityState
      readonly authorityVersion: number
    }
  | { readonly _tag: 'ReplayPaperGeneration'; readonly current: AuthorityState }

export type PaperAuthorityAlgebraFailure =
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
      readonly cause: unknown
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
      readonly _tag: 'PaperRuntimeBindingUnavailable'
      readonly operation: 'PREPARE' | 'activation'
      readonly expectedMaximum: Authority
      readonly configuredMaximum: Authority
      readonly hasAccountBinding: boolean
      readonly hasQualificationBinding: boolean
    }
  | {
      readonly _tag: 'PaperSourceAuthorityNotObserve'
      readonly generationHash: string
      readonly maximum: Authority
      readonly effective: Authority
    }
  | {
      readonly _tag: 'PaperPrepareGenerationMismatch'
      readonly currentGenerationHash: string
      readonly configuredGenerationHash: string
    }
  | { readonly _tag: 'QualificationEvidenceUnavailable'; readonly qualificationRunId: string }
  | {
      readonly _tag: 'QualificationEvidenceVerificationFailed'
      readonly qualificationRunId: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'QualificationEvidenceMismatch'
      readonly qualificationRunId: string
      readonly evidenceRunId: string
      readonly evidenceLockId: string
      readonly behaviorHash: string
      readonly parameterHash: string
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
  | { readonly _tag: 'PaperGenerationDerivationFailed'; readonly cause: unknown }
  | {
      readonly _tag: 'ReconciliationNotFresh'
      readonly reconciledAt: Date
      readonly observedAt: Date
      readonly staleThresholdMs: number
    }
  | {
      readonly _tag: 'DurablePaperGenerationMismatch'
      readonly durableGenerationHash: string
      readonly configuredGenerationHash: string
    }
  | {
      readonly _tag: 'PaperGenerationReplayMismatch'
      readonly generationHash: string
      readonly accountId: string
      readonly qualificationRunId: string
    }
  | {
      readonly _tag: 'DerivedPaperGenerationMismatch'
      readonly derivedGenerationHash: string
      readonly configuredGenerationHash: string
    }

export interface PaperAuthorityFailureDetails {
  readonly failure: 'conflict' | 'decode' | 'invariant'
  readonly message: string
  readonly cause?: unknown
}

const fail = <A>(failure: PaperAuthorityAlgebraFailure): Result.Result<A, PaperAuthorityAlgebraFailure> =>
  Result.fail(failure)

export const validateObserveGenerationRequest = (input: {
  readonly generationHash: string
  readonly maximum: Authority
}): Result.Result<ObserveGenerationRequest, PaperAuthorityAlgebraFailure> =>
  input.maximum === Authority.Observe
    ? Result.succeed({ generationHash: input.generationHash, maximum: Authority.Observe })
    : fail({ _tag: 'ObserveMaximumRequired', maximum: input.maximum })

export const nextAuthorityVersion = (current: {
  readonly generationHash: string
  readonly version: number
}): Result.Result<number, PaperAuthorityAlgebraFailure> => {
  const authorityVersion = current.version + 1
  return Number.isSafeInteger(authorityVersion)
    ? Result.succeed(authorityVersion)
    : fail({
        _tag: 'AuthorityVersionExhausted',
        generationHash: current.generationHash,
        currentAuthorityVersion: current.version,
      })
}

export const decideObserveGeneration = (
  input: ObserveGenerationRequest,
  current: AuthorityState | undefined,
): Result.Result<ObserveGenerationDecision, PaperAuthorityAlgebraFailure> => {
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

export const validateAuthorityObservation = (
  current: AuthorityState,
  observedAt: Date,
): Result.Result<void, PaperAuthorityAlgebraFailure> => {
  const updatedAt = new Date(current.updatedAt)
  return updatedAt.getTime() <= observedAt.getTime()
    ? Result.succeed(undefined)
    : fail({
        _tag: 'AuthorityUpdateAfterObservation',
        generationHash: current.generationHash,
        updatedAt,
        observedAt,
      })
}

export const validateCurrentGenerationHistory = <History extends AuthorityGenerationHistoryFacts>(
  current: AuthorityState,
  history: History | undefined,
): Result.Result<History, PaperAuthorityAlgebraFailure> => {
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
  const historyActivatedAtResult = Result.try({
    try: () => history.activatedAt.toISOString(),
    catch: (cause): PaperAuthorityAlgebraFailure => ({
      _tag: 'InvalidGenerationHistoryActivatedAt',
      generationHash: history.generationHash,
      activatedAt: history.activatedAt,
      cause,
    }),
  })
  if (Result.isFailure(historyActivatedAtResult)) return Result.fail(historyActivatedAtResult.failure)
  const historyActivatedAt = historyActivatedAtResult.success
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

export const requireUnusedAuthorityGeneration = (
  generationHash: string,
  existing: AuthorityGenerationHistoryFacts | undefined,
): Result.Result<void, PaperAuthorityAlgebraFailure> =>
  existing === undefined ? Result.succeed(undefined) : fail({ _tag: 'AuthorityGenerationAlreadyUsed', generationHash })

export const bindPaperGenerationRuntime = (
  facts: PaperGenerationRuntimeFacts,
  expectedMaximum: Authority,
  operation: 'PREPARE' | 'activation',
): Result.Result<PaperGenerationRuntimeBinding, PaperAuthorityAlgebraFailure> => {
  if (
    facts.maximumAuthority !== expectedMaximum ||
    facts.alpaca === undefined ||
    facts.qualificationRunId === undefined
  ) {
    return fail({
      _tag: 'PaperRuntimeBindingUnavailable',
      operation,
      expectedMaximum,
      configuredMaximum: facts.maximumAuthority,
      hasAccountBinding: facts.alpaca !== undefined,
      hasQualificationBinding: facts.qualificationRunId !== undefined,
    })
  }
  return Result.succeed({
    accountId: facts.alpaca.accountId,
    configuredGenerationHash: facts.alpaca.authorityGenerationHash,
    qualificationRunId: facts.qualificationRunId,
  })
}

export const validatePaperSourceAuthority = (
  current: AuthorityState,
): Result.Result<void, PaperAuthorityAlgebraFailure> =>
  current.maximum === Authority.Observe && current.effective === Authority.Observe
    ? Result.succeed(undefined)
    : fail({
        _tag: 'PaperSourceAuthorityNotObserve',
        generationHash: current.generationHash,
        maximum: current.maximum,
        effective: current.effective,
      })

export const validatePaperPrepareGeneration = (
  current: AuthorityState,
  binding: PaperGenerationRuntimeBinding,
): Result.Result<void, PaperAuthorityAlgebraFailure> =>
  current.generationHash === binding.configuredGenerationHash
    ? Result.succeed(undefined)
    : fail({
        _tag: 'PaperPrepareGenerationMismatch',
        currentGenerationHash: current.generationHash,
        configuredGenerationHash: binding.configuredGenerationHash,
      })

export const validatePaperGenerationEvidence = (
  evidence: PaperGenerationEvidenceFacts | undefined,
  binding: PaperGenerationRuntimeBinding,
  build: AuthorityBuildFacts,
): Result.Result<PaperGenerationEvidenceFacts, PaperAuthorityAlgebraFailure> => {
  if (evidence === undefined) {
    return fail({ _tag: 'QualificationEvidenceUnavailable', qualificationRunId: binding.qualificationRunId })
  }
  const verified = Result.try({
    try: () => {
      const strategyProtocolHash = makeStrategyProtocolHash({
        name: evidence.strategyName,
        behaviorHash: evidence.behaviorHash,
        parameterHash: evidence.parameterHash,
        parameterSchemaVersion: evidence.protocolSchemaVersion,
      })
      return (
        evidence.result.verdict === 'QUALIFIED' &&
        evidence.runStatus === 'COMPLETE' &&
        evidence.expectedArtifactCount === evidence.artifactCount &&
        evidence.expectedEventCount === evidence.eventCount &&
        evidence.expectedGateCount === evidence.gateCount &&
        evidence.statusCount === 2 &&
        evidence.writingStatusCount === 1 &&
        evidence.completeStatusCount === 1 &&
        canonicalHashV1(evidence.writingDetail) ===
          canonicalHashV1({
            artifactCount: evidence.expectedArtifactCount,
            eventCount: evidence.expectedEventCount,
            gateCount: evidence.expectedGateCount,
          }) &&
        canonicalHashV1(evidence.completeDetail) ===
          canonicalHashV1({
            reconciliationExact: true,
            verdict: evidence.result.evaluationVerdict.status,
          }) &&
        evidence.result.runId === binding.qualificationRunId &&
        evidence.result.lockId === evidence.lock.lockId &&
        evidence.lock.candidateRunId === binding.qualificationRunId &&
        evidence.protocolSchemaVersion === 'bayn.risk-balanced-trend.protocol.v3' &&
        evidence.strategyName === 'risk-balanced-trend' &&
        evidence.behaviorHash === build.strategyBehaviorHash &&
        evidence.parameterHash === build.strategyParameterHash &&
        canonicalHashV1(evidence.parameters) === evidence.parameterHash &&
        strategyProtocolHash === evidence.lock.protocolHash
      )
    },
    catch: (cause): PaperAuthorityAlgebraFailure => ({
      _tag: 'QualificationEvidenceVerificationFailed',
      qualificationRunId: binding.qualificationRunId,
      cause,
    }),
  })
  if (Result.isFailure(verified)) return Result.fail(verified.failure)
  return verified.success
    ? Result.succeed(evidence)
    : fail({
        _tag: 'QualificationEvidenceMismatch',
        qualificationRunId: binding.qualificationRunId,
        evidenceRunId: evidence.result.runId,
        evidenceLockId: evidence.lock.lockId,
        behaviorHash: evidence.behaviorHash,
        parameterHash: evidence.parameterHash,
      })
}

export const validateLatestExactReconciliation = (
  reconciliation: ExactReconciliationFacts | undefined,
  accountId: string,
): Result.Result<ExactReconciliationFacts, PaperAuthorityAlgebraFailure> => {
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

export const validateMutationCoverage = (
  baseline: MutationBaselineFacts,
  reconciliation: ExactReconciliationFacts,
): Result.Result<void, PaperAuthorityAlgebraFailure> =>
  baseline.unresolvedCount === 0 &&
  (baseline.latestMutationAt === null || baseline.latestMutationAt.getTime() <= reconciliation.reconciledAt.getTime())
    ? Result.succeed(undefined)
    : fail({
        _tag: 'MutationCoverageIncomplete',
        unresolvedCount: baseline.unresolvedCount,
        latestMutationAt: baseline.latestMutationAt,
        reconciledAt: reconciliation.reconciledAt,
      })

export const derivePaperAuthorityGeneration = (input: {
  readonly current: AuthorityState
  readonly proof: PaperAuthorityProofBinding
  readonly binding: PaperGenerationRuntimeBinding
  readonly evidence: PaperGenerationEvidenceFacts
  readonly reconciliation: ExactReconciliationFacts
  readonly build: AuthorityBuildFacts
}): Result.Result<DerivedPaperGeneration, PaperAuthorityAlgebraFailure> =>
  Result.try({
    try: () => ({
      current: input.current,
      generation: makePaperAuthorityGeneration({
        schemaVersion: 'bayn.paper-authority-generation.v2',
        maximum: Authority.Paper,
        previousGenerationHash: input.current.generationHash,
        qualificationRunId: input.evidence.result.runId,
        qualificationLockId: input.evidence.result.lockId,
        qualificationResultHash: input.evidence.result.resultHash,
        protocolHash: input.evidence.lock.protocolHash,
        qualificationExecutionPolicyHash: input.evidence.lock.policies.execution.contentHash,
        qualificationSourceRevision: input.evidence.lock.sourceRevision,
        qualificationImageRepository: input.evidence.lock.image.repository,
        qualificationImageDigest: input.evidence.lock.image.digest,
        activationSourceRevision: input.build.sourceRevision,
        activationImageRepository: input.build.imageRepository,
        activationImageDigest: input.build.imageDigest,
        strategyName: input.evidence.strategyName,
        strategyBehaviorHash: input.evidence.behaviorHash,
        strategyParameterHash: input.evidence.parameterHash,
        strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v3',
        accountId: input.binding.accountId,
        riskPolicyHash: input.proof.riskPolicyHash,
        proofPlanHash: input.proof.proofPlanHash,
        reconciliationId: input.reconciliation.reconciliationId,
        reconciliationContentHash: input.reconciliation.contentHash,
      }),
      reconciliation: input.reconciliation,
    }),
    catch: (cause): PaperAuthorityAlgebraFailure => ({ _tag: 'PaperGenerationDerivationFailed', cause }),
  })

export const validatePaperGenerationFreshness = (
  reconciliation: ExactReconciliationFacts,
  observedAt: Date,
  staleThresholdMs: number,
): Result.Result<Date, PaperAuthorityAlgebraFailure> =>
  reconciliation.reconciledAt.getTime() <= observedAt.getTime() &&
  observedAt.getTime() - reconciliation.reconciledAt.getTime() < staleThresholdMs
    ? Result.succeed(observedAt)
    : fail({
        _tag: 'ReconciliationNotFresh',
        reconciledAt: reconciliation.reconciledAt,
        observedAt,
        staleThresholdMs,
      })

export const decidePaperActivation = (
  current: AuthorityState,
  binding: PaperGenerationRuntimeBinding,
): Result.Result<PaperActivationDecision, PaperAuthorityAlgebraFailure> => {
  if (current.maximum !== Authority.Paper) {
    return Result.map(
      nextAuthorityVersion(current),
      (authorityVersion): PaperActivationDecision => ({
        _tag: 'ActivatePaperGeneration',
        current,
        authorityVersion,
      }),
    )
  }
  return current.generationHash === binding.configuredGenerationHash
    ? Result.succeed({ _tag: 'ReplayPaperGeneration', current })
    : fail({
        _tag: 'DurablePaperGenerationMismatch',
        durableGenerationHash: current.generationHash,
        configuredGenerationHash: binding.configuredGenerationHash,
      })
}

export const validatePaperGenerationReplay = (
  stored: PaperAuthorityGeneration,
  binding: PaperGenerationRuntimeBinding,
  proof: PaperAuthorityProofBinding,
  build: AuthorityBuildFacts,
): Result.Result<void, PaperAuthorityAlgebraFailure> =>
  stored.accountId === binding.accountId &&
  stored.qualificationRunId === binding.qualificationRunId &&
  stored.activationSourceRevision === build.sourceRevision &&
  stored.activationImageRepository === build.imageRepository &&
  stored.activationImageDigest === build.imageDigest &&
  stored.strategyBehaviorHash === build.strategyBehaviorHash &&
  stored.strategyParameterHash === build.strategyParameterHash &&
  stored.riskPolicyHash === proof.riskPolicyHash &&
  stored.proofPlanHash === proof.proofPlanHash
    ? Result.succeed(undefined)
    : fail({
        _tag: 'PaperGenerationReplayMismatch',
        generationHash: stored.generationHash,
        accountId: binding.accountId,
        qualificationRunId: binding.qualificationRunId,
      })

export const validateDerivedPaperGeneration = (
  generation: PaperAuthorityGeneration,
  binding: PaperGenerationRuntimeBinding,
): Result.Result<void, PaperAuthorityAlgebraFailure> =>
  generation.generationHash === binding.configuredGenerationHash
    ? Result.succeed(undefined)
    : fail({
        _tag: 'DerivedPaperGenerationMismatch',
        derivedGenerationHash: generation.generationHash,
        configuredGenerationHash: binding.configuredGenerationHash,
      })

export const paperActivationEffectiveAuthority = (kill: KillState): Authority =>
  kill === KillState.Active ? Authority.Observe : Authority.Paper

export const paperAuthorityFailureDetails = (failure: PaperAuthorityAlgebraFailure): PaperAuthorityFailureDetails => {
  switch (failure._tag) {
    case 'ObserveMaximumRequired':
      return { failure: 'invariant', message: 'Phase A authority maximum must be OBSERVE' }
    case 'CurrentGenerationHistoryMissing':
      return { failure: 'invariant', message: 'current authority generation lacks immutable history' }
    case 'InvalidGenerationHistoryVersion':
      return {
        failure: 'invariant',
        message: 'authority generation history version is not a safe positive integer',
      }
    case 'InvalidGenerationHistoryActivatedAt':
      return {
        failure: 'invariant',
        message: 'current authority generation history differs from state',
        cause: failure.cause,
      }
    case 'CurrentGenerationHistoryMismatch':
      return { failure: 'invariant', message: 'current authority generation history differs from state' }
    case 'AuthorityUpdateAfterObservation':
      return {
        failure: 'invariant',
        message: 'durable authority update follows its database observation time',
      }
    case 'AuthorityVersionExhausted':
      return {
        failure: 'invariant',
        message: 'durable authority version is not a safe positive integer',
      }
    case 'AuthorityGenerationAlreadyUsed':
      return { failure: 'conflict', message: 'authority generation hash was already used' }
    case 'AuthorityMaximumConflict':
      return { failure: 'conflict', message: 'authority generation maximum conflicts with durable state' }
    case 'PaperRuntimeBindingUnavailable':
      return {
        failure: 'invariant',
        message: `PAPER ${failure.operation} requires the exact configured authority, account, generation, and qualification binding`,
      }
    case 'PaperSourceAuthorityNotObserve':
      return { failure: 'invariant', message: 'PAPER generation requires current OBSERVE authority' }
    case 'PaperPrepareGenerationMismatch':
      return {
        failure: 'invariant',
        message: 'PAPER PREPARE current authority differs from the configured OBSERVE generation',
      }
    case 'QualificationEvidenceUnavailable':
      return { failure: 'invariant', message: 'exact terminal qualification evidence is unavailable' }
    case 'QualificationEvidenceVerificationFailed':
      return {
        failure: 'invariant',
        message: 'PAPER generation differs from terminal qualification evidence or current strategy build',
        cause: failure.cause,
      }
    case 'QualificationEvidenceMismatch':
      return {
        failure: 'invariant',
        message: 'PAPER generation differs from terminal qualification evidence or current strategy build',
      }
    case 'ExactReconciliationUnavailable':
    case 'ReconciliationNotFresh':
      return {
        failure: 'invariant',
        message: 'PAPER generation requires the latest fresh exact account reconciliation',
      }
    case 'MutationCoverageIncomplete':
      return {
        failure: 'invariant',
        message: 'PAPER generation requires zero unresolved mutations covered by reconciliation',
      }
    case 'PaperGenerationDerivationFailed':
      return {
        failure: 'decode',
        message: 'derived PAPER generation is invalid',
        cause: failure.cause,
      }
    case 'DurablePaperGenerationMismatch':
      return { failure: 'conflict', message: 'durable PAPER generation differs from the configured generation' }
    case 'PaperGenerationReplayMismatch':
      return { failure: 'conflict', message: 'PAPER generation history differs from deterministic replay' }
    case 'DerivedPaperGenerationMismatch':
      return { failure: 'invariant', message: 'derived PAPER generation differs from the configured generation' }
  }
}
