import { DateTime, pipe, Result } from 'effect'

import type { RuntimeBuildMetadata } from '../config'
import { makeStrategyProtocolHashResult, type ContractConstructionFailure } from '../contracts'
import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import {
  Authority,
  KillState,
  ReconciliationStatus,
  makeCapitalGrantGenerationResult,
  makeResearchCapitalGrantGenerationResult,
  type AuthorityState,
  type CapitalGrantGeneration,
  type CapitalGrantGenerationConstructionFailure,
  type CapitalGrantGenerationMaterial,
  type CapitalGrantProofBinding,
  type ResearchCapitalGrantGeneration,
  type ResearchCapitalGrantGenerationConstructionFailure,
  type ResearchCapitalGrantGenerationMaterial,
  type ResearchCapitalGrantProofBinding,
} from '../execution/contracts'
import type { QualificationLock, QualificationResult } from '../qualification'
import { Pipeable } from '../pipeable'

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
  readonly protocolSchemaVersion: string
  readonly strategyName: string
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
  readonly generation: CapitalGrantGeneration
  readonly reconciliation: ExactReconciliationFacts
}

export interface DerivedResearchPaperGeneration {
  readonly current: AuthorityState
  readonly generation: ResearchCapitalGrantGeneration
  readonly reconciliation: ExactReconciliationFacts
}

interface QualificationEvidenceVerificationFacts {
  readonly verdict: QualificationResult['verdict']
  readonly runStatus: PaperGenerationEvidenceFacts['runStatus']
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
  readonly evaluationVerdictStatus: QualificationResult['evaluationVerdict']['status']
  readonly resultRunId: string
  readonly resultLockId: string
  readonly lockId: string
  readonly candidateRunId: string
  readonly protocolSchemaVersion: PaperGenerationEvidenceFacts['protocolSchemaVersion']
  readonly strategyName: PaperGenerationEvidenceFacts['strategyName']
  readonly behaviorHash: string
  readonly parameterHash: string
  readonly parameters: unknown
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly lockProtocolHash: string
}

type AuthorityBuildFacts = Pick<
  RuntimeBuildMetadata,
  'sourceRevision' | 'imageRepository' | 'imageDigest' | 'strategyBehaviorHash' | 'strategyParameterHash'
>

type QualificationEvidenceVerificationOperation =
  | 'complete-detail'
  | 'complete-expected'
  | 'parameters'
  | 'strategy-protocol'
  | 'writing-detail'
  | 'writing-expected'

type QualificationEvidenceVerificationCause = ContractConstructionFailure | CanonicalHashFailure

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
      readonly _tag: 'QualificationEvidenceAccessFailed'
      readonly qualificationRunId: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'QualificationEvidenceVerificationFailed'
      readonly qualificationRunId: string
      readonly operation: QualificationEvidenceVerificationOperation
      readonly cause: QualificationEvidenceVerificationCause
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
  | { readonly _tag: 'ResearchPaperGenerationDerivationFailed'; readonly cause: unknown }
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
  | {
      readonly _tag: 'ResearchPaperGenerationReplayMismatch'
      readonly generationHash: string
      readonly expectedPreviousGenerationHash: string
    }
  | {
      readonly _tag: 'ResearchPaperGenerationRuntimeMismatch'
      readonly field:
        | 'accountId'
        | 'activationBuild'
        | 'brokerIdentityHash'
        | 'generationHash'
        | 'proofPlanHash'
        | 'riskPolicyHash'
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
}): Result.Result<ObserveGenerationRequest, CapitalGrantAlgebraFailure> =>
  input.maximum === Authority.Observe
    ? Result.succeed({ generationHash: input.generationHash, maximum: Authority.Observe })
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

const bindPaperGenerationRuntimeDataFirst = (
  facts: PaperGenerationRuntimeFacts,
  expectedMaximum: Authority,
  operation: 'PREPARE' | 'activation',
): Result.Result<PaperGenerationRuntimeBinding, CapitalGrantAlgebraFailure> => {
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

export const bindPaperGenerationRuntime = Pipeable.dual(3, bindPaperGenerationRuntimeDataFirst)

export const validatePaperSourceAuthority = (
  current: AuthorityState,
): Result.Result<void, CapitalGrantAlgebraFailure> =>
  current.maximum === Authority.Observe && current.effective === Authority.Observe
    ? Result.succeed(undefined)
    : fail({
        _tag: 'PaperSourceAuthorityNotObserve',
        generationHash: current.generationHash,
        maximum: current.maximum,
        effective: current.effective,
      })

const validatePaperPrepareGenerationDataFirst = (
  current: AuthorityState,
  binding: PaperGenerationRuntimeBinding,
): Result.Result<void, CapitalGrantAlgebraFailure> =>
  current.generationHash === binding.configuredGenerationHash
    ? Result.succeed(undefined)
    : fail({
        _tag: 'PaperPrepareGenerationMismatch',
        currentGenerationHash: current.generationHash,
        configuredGenerationHash: binding.configuredGenerationHash,
      })

export const validatePaperPrepareGeneration = Pipeable.dual(2, validatePaperPrepareGenerationDataFirst)

const readQualificationEvidenceVerificationFacts = (
  evidence: PaperGenerationEvidenceFacts,
  binding: PaperGenerationRuntimeBinding,
  build: AuthorityBuildFacts,
): Result.Result<QualificationEvidenceVerificationFacts, CapitalGrantAlgebraFailure> =>
  Result.try({
    try: () => ({
      verdict: evidence.result.verdict,
      runStatus: evidence.runStatus,
      expectedArtifactCount: evidence.expectedArtifactCount,
      expectedEventCount: evidence.expectedEventCount,
      expectedGateCount: evidence.expectedGateCount,
      artifactCount: evidence.artifactCount,
      eventCount: evidence.eventCount,
      gateCount: evidence.gateCount,
      statusCount: evidence.statusCount,
      writingStatusCount: evidence.writingStatusCount,
      completeStatusCount: evidence.completeStatusCount,
      writingDetail: evidence.writingDetail,
      completeDetail: evidence.completeDetail,
      evaluationVerdictStatus: evidence.result.evaluationVerdict.status,
      resultRunId: evidence.result.runId,
      resultLockId: evidence.result.lockId,
      lockId: evidence.lock.lockId,
      candidateRunId: evidence.lock.candidateRunId,
      protocolSchemaVersion: evidence.protocolSchemaVersion,
      strategyName: evidence.strategyName,
      behaviorHash: evidence.behaviorHash,
      parameterHash: evidence.parameterHash,
      parameters: evidence.parameters,
      strategyBehaviorHash: build.strategyBehaviorHash,
      strategyParameterHash: build.strategyParameterHash,
      lockProtocolHash: evidence.lock.protocolHash,
    }),
    catch: (cause): CapitalGrantAlgebraFailure => ({
      _tag: 'QualificationEvidenceAccessFailed',
      qualificationRunId: binding.qualificationRunId,
      cause,
    }),
  })

const qualificationEvidenceHash = (
  operation: Exclude<QualificationEvidenceVerificationOperation, 'strategy-protocol'>,
  value: unknown,
  binding: PaperGenerationRuntimeBinding,
): Result.Result<string, CapitalGrantAlgebraFailure> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): CapitalGrantAlgebraFailure => ({
      _tag: 'QualificationEvidenceVerificationFailed',
      qualificationRunId: binding.qualificationRunId,
      operation,
      cause,
    }),
  )

const validatePaperGenerationEvidenceDataFirst = (
  evidence: PaperGenerationEvidenceFacts | undefined,
  binding: PaperGenerationRuntimeBinding,
  build: AuthorityBuildFacts,
): Result.Result<PaperGenerationEvidenceFacts, CapitalGrantAlgebraFailure> => {
  if (evidence === undefined) {
    return fail({ _tag: 'QualificationEvidenceUnavailable', qualificationRunId: binding.qualificationRunId })
  }
  return Result.gen(function* () {
    const facts = yield* readQualificationEvidenceVerificationFacts(evidence, binding, build)
    const strategyProtocolHash = yield* Result.mapError(
      makeStrategyProtocolHashResult({
        name: facts.strategyName,
        behaviorHash: facts.behaviorHash,
        parameterHash: facts.parameterHash,
        parameterSchemaVersion: facts.protocolSchemaVersion,
      }),
      (cause): CapitalGrantAlgebraFailure => ({
        _tag: 'QualificationEvidenceVerificationFailed',
        qualificationRunId: binding.qualificationRunId,
        operation: 'strategy-protocol',
        cause,
      }),
    )
    const writingDetailHash = yield* qualificationEvidenceHash('writing-detail', facts.writingDetail, binding)
    const writingExpectedHash = yield* qualificationEvidenceHash(
      'writing-expected',
      {
        artifactCount: facts.expectedArtifactCount,
        eventCount: facts.expectedEventCount,
        gateCount: facts.expectedGateCount,
      },
      binding,
    )
    const completeDetailHash = yield* qualificationEvidenceHash('complete-detail', facts.completeDetail, binding)
    const completeExpectedHash = yield* qualificationEvidenceHash(
      'complete-expected',
      { reconciliationExact: true, verdict: facts.evaluationVerdictStatus },
      binding,
    )
    const parametersHash = yield* qualificationEvidenceHash('parameters', facts.parameters, binding)
    const verified =
      facts.verdict === 'QUALIFIED' &&
      facts.runStatus === 'COMPLETE' &&
      facts.expectedArtifactCount === facts.artifactCount &&
      facts.expectedEventCount === facts.eventCount &&
      facts.expectedGateCount === facts.gateCount &&
      facts.statusCount === 2 &&
      facts.writingStatusCount === 1 &&
      facts.completeStatusCount === 1 &&
      writingDetailHash === writingExpectedHash &&
      completeDetailHash === completeExpectedHash &&
      facts.resultRunId === binding.qualificationRunId &&
      facts.resultLockId === facts.lockId &&
      facts.candidateRunId === binding.qualificationRunId &&
      facts.behaviorHash === facts.strategyBehaviorHash &&
      facts.parameterHash === facts.strategyParameterHash &&
      parametersHash === facts.parameterHash &&
      strategyProtocolHash === facts.lockProtocolHash

    if (verified) return evidence
    return yield* fail<PaperGenerationEvidenceFacts>({
      _tag: 'QualificationEvidenceMismatch',
      qualificationRunId: binding.qualificationRunId,
      evidenceRunId: facts.resultRunId,
      evidenceLockId: facts.lockId,
      behaviorHash: facts.behaviorHash,
      parameterHash: facts.parameterHash,
    })
  })
}

export const validatePaperGenerationEvidence = Pipeable.dual(3, validatePaperGenerationEvidenceDataFirst)

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

const readCapitalGrantGenerationMaterial = (input: {
  readonly current: AuthorityState
  readonly proof: CapitalGrantProofBinding
  readonly binding: PaperGenerationRuntimeBinding
  readonly evidence: PaperGenerationEvidenceFacts
  readonly reconciliation: ExactReconciliationFacts
  readonly build: AuthorityBuildFacts
}): Result.Result<CapitalGrantGenerationMaterial, CapitalGrantAlgebraFailure> =>
  Result.try({
    try: () => ({
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
      strategyParameterSchemaVersion: input.evidence.protocolSchemaVersion,
      accountId: input.binding.accountId,
      riskPolicyHash: input.proof.riskPolicyHash,
      proofPlanHash: input.proof.proofPlanHash,
      reconciliationId: input.reconciliation.reconciliationId,
      reconciliationContentHash: input.reconciliation.contentHash,
    }),
    catch: (cause): CapitalGrantAlgebraFailure => ({ _tag: 'PaperGenerationDerivationFailed', cause }),
  })

export const deriveCapitalGrantGeneration = (input: {
  readonly current: AuthorityState
  readonly proof: CapitalGrantProofBinding
  readonly binding: PaperGenerationRuntimeBinding
  readonly evidence: PaperGenerationEvidenceFacts
  readonly reconciliation: ExactReconciliationFacts
  readonly build: AuthorityBuildFacts
}): Result.Result<DerivedPaperGeneration, CapitalGrantAlgebraFailure> =>
  pipe(
    readCapitalGrantGenerationMaterial(input),
    Result.flatMap((material) =>
      pipe(
        makeCapitalGrantGenerationResult(material),
        Result.mapError(
          (cause: CapitalGrantGenerationConstructionFailure): CapitalGrantAlgebraFailure => ({
            _tag: 'PaperGenerationDerivationFailed',
            cause,
          }),
        ),
      ),
    ),
    Result.map((generation) => ({ current: input.current, generation, reconciliation: input.reconciliation })),
  )

const researchRuntimeMismatch = (
  field: Extract<CapitalGrantAlgebraFailure, { readonly _tag: 'ResearchPaperGenerationRuntimeMismatch' }>['field'],
): Result.Result<never, CapitalGrantAlgebraFailure> =>
  Result.fail({ _tag: 'ResearchPaperGenerationRuntimeMismatch', field })

export const validateResearchCapitalGrantProof = (input: {
  readonly proof: ResearchCapitalGrantProofBinding
  readonly configuredSourceGenerationHash: string
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
  return /^[0-9a-f]{64}$/.test(input.configuredSourceGenerationHash)
    ? Result.succeed(undefined)
    : researchRuntimeMismatch('generationHash')
}

const researchCapitalGrantGenerationMaterial = (input: {
  readonly current: AuthorityState
  readonly proof: ResearchCapitalGrantProofBinding
  readonly reconciliation: ExactReconciliationFacts
}): ResearchCapitalGrantGenerationMaterial => ({
  schemaVersion: 'bayn.paper-authority-generation.v3',
  maximum: Authority.Paper,
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
}): Result.Result<DerivedResearchPaperGeneration, CapitalGrantAlgebraFailure> =>
  pipe(
    makeResearchCapitalGrantGenerationResult(researchCapitalGrantGenerationMaterial(input)),
    Result.mapError(
      (cause: ResearchCapitalGrantGenerationConstructionFailure): CapitalGrantAlgebraFailure => ({
        _tag: 'ResearchPaperGenerationDerivationFailed',
        cause,
      }),
    ),
    Result.map((generation) => ({ current: input.current, generation, reconciliation: input.reconciliation })),
  )

const validateResearchPaperGenerationReplayDataFirst = (
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
        _tag: 'ResearchPaperGenerationReplayMismatch',
        generationHash: stored.generationHash,
        expectedPreviousGenerationHash,
      })

export const validateResearchPaperGenerationReplay = Pipeable.dual(3, validateResearchPaperGenerationReplayDataFirst)

const validatePaperGenerationFreshnessDataFirst = (
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

export const validatePaperGenerationFreshness = Pipeable.dual(3, validatePaperGenerationFreshnessDataFirst)

const decidePaperActivationDataFirst = (
  current: AuthorityState,
  binding: Pick<PaperGenerationRuntimeBinding, 'configuredGenerationHash'>,
): Result.Result<PaperActivationDecision, CapitalGrantAlgebraFailure> => {
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

export const decidePaperActivation = Pipeable.dual(2, decidePaperActivationDataFirst)

const validatePaperGenerationReplayDataFirst = (
  stored: CapitalGrantGeneration,
  binding: PaperGenerationRuntimeBinding,
  proof: CapitalGrantProofBinding,
  build: AuthorityBuildFacts,
): Result.Result<void, CapitalGrantAlgebraFailure> =>
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

export const validatePaperGenerationReplay = Pipeable.dual(4, validatePaperGenerationReplayDataFirst)

const validateDerivedPaperGenerationDataFirst = (
  generation: CapitalGrantGeneration,
  binding: PaperGenerationRuntimeBinding,
): Result.Result<void, CapitalGrantAlgebraFailure> =>
  generation.generationHash === binding.configuredGenerationHash
    ? Result.succeed(undefined)
    : fail({
        _tag: 'DerivedPaperGenerationMismatch',
        derivedGenerationHash: generation.generationHash,
        configuredGenerationHash: binding.configuredGenerationHash,
      })

export const validateDerivedPaperGeneration = Pipeable.dual(2, validateDerivedPaperGenerationDataFirst)

export const paperActivationEffectiveAuthority = (kill: KillState): Authority =>
  kill === KillState.Active ? Authority.Observe : Authority.Paper

export const capitalGrantFailureDetails = (failure: CapitalGrantAlgebraFailure): CapitalGrantFailureDetails => {
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
        cause: failure,
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
    case 'QualificationEvidenceAccessFailed':
      return {
        failure: 'invariant',
        message: 'PAPER qualification evidence could not be read safely',
        cause: failure.cause,
      }
    case 'QualificationEvidenceVerificationFailed':
      return {
        failure: 'invariant',
        message: `PAPER qualification evidence ${failure.operation} verification failed`,
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
    case 'ResearchPaperGenerationDerivationFailed':
      return {
        failure: 'decode',
        message: 'derived research PAPER generation is invalid',
        cause: failure.cause,
      }
    case 'DurablePaperGenerationMismatch':
      return { failure: 'conflict', message: 'durable PAPER generation differs from the configured generation' }
    case 'PaperGenerationReplayMismatch':
      return { failure: 'conflict', message: 'PAPER generation history differs from deterministic replay' }
    case 'DerivedPaperGenerationMismatch':
      return { failure: 'invariant', message: 'derived PAPER generation differs from the configured generation' }
    case 'ResearchPaperGenerationReplayMismatch':
      return { failure: 'conflict', message: 'research PAPER generation history differs from deterministic replay' }
    case 'ResearchPaperGenerationRuntimeMismatch':
      return {
        failure: 'invariant',
        message: `research PAPER generation ${failure.field} binding differs from the current runtime`,
      }
  }
}
