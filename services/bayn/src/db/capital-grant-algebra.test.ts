import { describe, expect, test } from 'bun:test'

import { DateTime, Result } from 'effect'

import { config, fixtureLock, fixtureQualification } from '../app-test-support'
import { canonicalHashV1 } from '../hash'
import {
  Authority,
  KillState,
  ReconciliationStatus,
  type AuthorityState,
  type CapitalGrantProofBinding,
  type ResearchCapitalGrantGenerationMaterial,
  type ResearchCapitalGrantProofBinding,
} from '../execution/contracts'
import { makeQualificationResult } from '../qualification'
import {
  analyzeQualification,
  defaultQualificationStatisticsPolicy,
  type QualificationSeries,
} from '../qualification-statistics'
import { fixtureProtocol } from '../test-fixtures'
import {
  bindPaperGenerationRuntime,
  decideObserveGeneration,
  decidePaperActivation,
  deriveCapitalGrantGeneration,
  deriveResearchCapitalGrantGeneration,
  nextAuthorityVersion,
  paperActivationEffectiveAuthority,
  capitalGrantFailureDetails,
  requireUnusedAuthorityGeneration,
  validateAuthorityObservation,
  validateCurrentGenerationHistory,
  validateDerivedPaperGeneration,
  validateLatestExactReconciliation,
  validateMutationCoverage,
  validateObserveGenerationRequest,
  validatePaperGenerationEvidence,
  validatePaperGenerationFreshness,
  validatePaperGenerationReplay,
  validatePaperPrepareGeneration,
  validatePreparedPaperActivation,
  validatePaperSourceAuthority,
  validateResearchCapitalGrantProof,
  validateResearchPaperGenerationReplay,
  type ExactReconciliationFacts,
  type CapitalGrantAlgebraFailure,
  type PaperGenerationEvidenceFacts,
  type PaperGenerationRuntimeBinding,
} from './capital-grant-algebra'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error('expected success')
  return result.success
}

const failureOf = <A>(result: Result.Result<A, CapitalGrantAlgebraFailure>): CapitalGrantAlgebraFailure => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error('expected failure')
  return result.failure
}

const hash = (value: string): string => canonicalHashV1({ value })
const accountId = 'paper-authority-account'
const observeGenerationHash = hash('observe-generation')
const sqlTimestamp = (value: string | number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value))
const invalidSqlTimestamp = (): Date => {
  const value = Object.create(Date.prototype) as Date
  Object.defineProperty(value, 'getTime', { value: () => Number.NaN })
  return value
}
const updatedAt = sqlTimestamp('2026-07-25T20:00:00.000Z')
const observedAt = sqlTimestamp('2026-07-25T20:00:01.000Z')

const observeAuthority: AuthorityState = {
  schemaVersion: 'bayn.paper-authority.v1',
  generationHash: observeGenerationHash,
  maximum: Authority.Observe,
  effective: Authority.Observe,
  kill: KillState.Clear,
  version: 1,
  updatedAt: updatedAt.toISOString(),
}

const observeHistory = {
  generationHash: observeGenerationHash,
  maximum: Authority.Observe,
  authorityVersion: '1',
  activatedAt: updatedAt,
}

const prepareBinding: PaperGenerationRuntimeBinding = {
  accountId,
  configuredGenerationHash: observeGenerationHash,
  qualificationRunId: fixtureQualification.runId,
}

const proof: CapitalGrantProofBinding = {
  schemaVersion: 'bayn.paper-authority-proof-binding.v1',
  riskPolicyHash: hash('risk-policy'),
  proofPlanHash: hash('proof-plan'),
}

const reconciliation: ExactReconciliationFacts = {
  reconciliationId: hash('reconciliation'),
  accountId,
  contentHash: hash('reconciliation-content'),
  status: ReconciliationStatus.Exact,
  reconciledAt: sqlTimestamp('2026-07-25T20:00:00.500Z'),
}

const researchProof = (): ResearchCapitalGrantProofBinding => {
  const material: ResearchCapitalGrantGenerationMaterial = {
    schemaVersion: 'bayn.paper-authority-generation.v3' as const,
    maximum: Authority.Paper,
    previousGenerationHash: observeGenerationHash,
    grant: { _tag: 'Research' as const, planHash: hash('research-plan') },
    activationSourceRevision: config.build.sourceRevision,
    activationImageRepository: config.build.imageRepository,
    activationImageDigest: config.build.imageDigest,
    strategyName: 'risk-balanced-trend',
    strategyBehaviorHash: config.build.strategyBehaviorHash,
    strategyParameterHash: config.build.strategyParameterHash,
    strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
    strategyProtocolHash: hash('strategy-protocol'),
    accountId,
    brokerIdentityHash: hash('broker-identity'),
    riskPolicyHash: hash('risk-policy'),
    proofPlanHash: hash('research-plan'),
    reconciliationId: reconciliation.reconciliationId,
    reconciliationContentHash: reconciliation.contentHash,
  }
  return {
    schemaVersion: 'bayn.research-paper-grant-proof.v1',
    grant: material.grant,
    activationSourceRevision: material.activationSourceRevision,
    activationImageRepository: material.activationImageRepository,
    activationImageDigest: material.activationImageDigest,
    strategyName: material.strategyName,
    strategyBehaviorHash: material.strategyBehaviorHash,
    strategyParameterHash: material.strategyParameterHash,
    strategyParameterSchemaVersion: material.strategyParameterSchemaVersion,
    strategyProtocolHash: material.strategyProtocolHash,
    accountId: material.accountId,
    brokerIdentityHash: material.brokerIdentityHash,
    riskPolicyHash: material.riskPolicyHash,
    proofPlanHash: material.proofPlanHash,
  }
}

const qualificationSeries = (runId: string): QualificationSeries => {
  const sessionDate = (index: number): `${number}-${number}-${number}` =>
    DateTime.makeUnsafe('2000-01-01T00:00:00.000Z').pipe(
      DateTime.add({ days: index }),
      DateTime.formatIsoDate,
    ) as `${number}-${number}-${number}`
  const blockCount = 90
  return {
    schemaVersion: 'bayn.qualification-series.v1',
    runId,
    observations: Array.from({ length: blockCount * 21 + 10 }, (_, index) => {
      const noise = (((index * 17) % 23) - 11) / 100_000
      return {
        sessionDate: sessionDate(index),
        strategyReturn: 0.0005 + noise,
        cashReturn: 0,
        buyAndHoldReturn: 0.00015 + noise * 1.1,
        directVolatilityReturn: 0.0001 + noise * 0.8,
      }
    }),
    rebalanceExecutionDates: Array.from({ length: blockCount + 1 }, (_, index) => sessionDate(index * 21)),
  }
}

const qualifiedAnalysis = successOf(
  analyzeQualification(
    qualificationSeries(fixtureLock.candidateRunId),
    defaultQualificationStatisticsPolicy,
    fixtureLock.priorTrialRunIds,
  ),
)
const qualifiedResult = successOf(
  makeQualificationResult(
    fixtureLock,
    {
      status: 'PASS',
      gates: [{ name: 'paper_authority_algebra_fixture', passed: true, actual: 1, required: 1 }],
    },
    qualifiedAnalysis,
  ),
)

const evidence: PaperGenerationEvidenceFacts = {
  lock: fixtureLock,
  result: qualifiedResult,
  runStatus: 'COMPLETE',
  expectedArtifactCount: 3,
  expectedEventCount: 4,
  expectedGateCount: 5,
  artifactCount: 3,
  eventCount: 4,
  gateCount: 5,
  statusCount: 2,
  writingStatusCount: 1,
  completeStatusCount: 1,
  writingDetail: { artifactCount: 3, eventCount: 4, gateCount: 5 },
  completeDetail: { reconciliationExact: true, verdict: 'PASS' },
  protocolSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
  strategyName: 'risk-balanced-trend',
  behaviorHash: config.build.strategyBehaviorHash,
  parameterHash: config.build.strategyParameterHash,
  parameters: fixtureProtocol,
}

describe('PAPER authority algebra', () => {
  test('decides OBSERVE initialization, exact replay, and monotonic rotation', () => {
    const observeRequest = successOf(
      validateObserveGenerationRequest({ generationHash: observeGenerationHash, maximum: Authority.Observe }),
    )
    expect(observeRequest).toEqual({ generationHash: observeGenerationHash, maximum: Authority.Observe })
    expect(successOf(decideObserveGeneration(observeRequest, undefined))).toEqual({
      _tag: 'InitializeObserveGeneration',
      generationHash: observeGenerationHash,
      maximum: Authority.Observe,
    })
    expect(successOf(decideObserveGeneration(observeRequest, observeAuthority))).toEqual({
      _tag: 'ReplayObserveGeneration',
      current: observeAuthority,
    })

    const rotatedGenerationHash = hash('rotated-observe-generation')
    const rotationRequest = successOf(
      validateObserveGenerationRequest({ generationHash: rotatedGenerationHash, maximum: Authority.Observe }),
    )
    expect(successOf(decideObserveGeneration(rotationRequest, observeAuthority))).toEqual({
      _tag: 'RotateObserveGeneration',
      current: observeAuthority,
      generationHash: rotatedGenerationHash,
      maximum: Authority.Observe,
      authorityVersion: 2,
    })
    expect(
      failureOf(validateObserveGenerationRequest({ generationHash: hash('paper-request'), maximum: Authority.Paper })),
    ).toEqual({ _tag: 'ObserveMaximumRequired', maximum: Authority.Paper })
    expect(
      failureOf(
        requireUnusedAuthorityGeneration(rotatedGenerationHash, {
          ...observeHistory,
          generationHash: rotatedGenerationHash,
        }),
      ),
    ).toEqual({
      _tag: 'AuthorityGenerationAlreadyUsed',
      generationHash: rotatedGenerationHash,
    })
    expect(
      failureOf(
        decideObserveGeneration(observeRequest, {
          ...observeAuthority,
          maximum: Authority.Paper,
        }),
      ),
    ).toEqual({
      _tag: 'AuthorityMaximumConflict',
      generationHash: observeGenerationHash,
      requestedMaximum: Authority.Observe,
      durableMaximum: Authority.Paper,
    })
    const exhausted = failureOf(
      decideObserveGeneration(rotationRequest, {
        ...observeAuthority,
        version: Number.MAX_SAFE_INTEGER,
      }),
    )
    expect(exhausted).toEqual({
      _tag: 'AuthorityVersionExhausted',
      generationHash: observeGenerationHash,
      currentAuthorityVersion: Number.MAX_SAFE_INTEGER,
    })
    expect(capitalGrantFailureDetails(exhausted)).toEqual({
      failure: 'invariant',
      message: 'durable authority version is not a safe positive integer',
    })
  })

  test('validates database observation time and append-only current history', () => {
    expect(successOf(validateAuthorityObservation(observeAuthority, observedAt))).toBeUndefined()
    expect(successOf(validateCurrentGenerationHistory(observeAuthority, observeHistory))).toEqual(observeHistory)

    expect(
      failureOf(validateAuthorityObservation(observeAuthority, sqlTimestamp('2026-07-25T19:59:59.999Z'))),
    ).toMatchObject({
      _tag: 'AuthorityUpdateAfterObservation',
      generationHash: observeGenerationHash,
    })
    expect(failureOf(validateCurrentGenerationHistory(observeAuthority, undefined))).toEqual({
      _tag: 'CurrentGenerationHistoryMissing',
      generationHash: observeGenerationHash,
    })
    expect(
      failureOf(validateCurrentGenerationHistory(observeAuthority, { ...observeHistory, authorityVersion: 'NaN' })),
    ).toEqual({
      _tag: 'InvalidGenerationHistoryVersion',
      generationHash: observeGenerationHash,
      authorityVersion: 'NaN',
    })
    const invalidActivatedAt = invalidSqlTimestamp()
    const invalidTimestamp = failureOf(
      validateCurrentGenerationHistory(observeAuthority, {
        ...observeHistory,
        activatedAt: invalidActivatedAt,
      }),
    )
    expect(invalidTimestamp).toMatchObject({
      _tag: 'InvalidGenerationHistoryActivatedAt',
      generationHash: observeGenerationHash,
      activatedAt: invalidActivatedAt,
      epochMillis: Number.NaN,
    })
    if (invalidTimestamp._tag !== 'InvalidGenerationHistoryActivatedAt') {
      throw new Error('expected invalid generation history timestamp')
    }
    expect(capitalGrantFailureDetails(invalidTimestamp).cause).toBe(invalidTimestamp)
    expect(
      failureOf(
        validateCurrentGenerationHistory(observeAuthority, {
          ...observeHistory,
          generationHash: hash('wrong-history'),
        }),
      ),
    ).toMatchObject({
      _tag: 'CurrentGenerationHistoryMismatch',
      currentGenerationHash: observeGenerationHash,
    })
  })

  test('binds PREPARE runtime facts and rejects authority drift before evidence reads', () => {
    expect(
      successOf(
        bindPaperGenerationRuntime(
          {
            maximumAuthority: Authority.Observe,
            alpaca: { accountId, authorityGenerationHash: observeGenerationHash },
            qualificationRunId: fixtureQualification.runId,
          },
          Authority.Observe,
          'PREPARE',
        ),
      ),
    ).toEqual(prepareBinding)
    expect(successOf(validatePaperSourceAuthority(observeAuthority))).toBeUndefined()
    expect(successOf(validatePaperPrepareGeneration(observeAuthority, prepareBinding))).toBeUndefined()

    const missing = failureOf(
      bindPaperGenerationRuntime(
        {
          maximumAuthority: Authority.Paper,
          alpaca: undefined,
          qualificationRunId: undefined,
        },
        Authority.Observe,
        'PREPARE',
      ),
    )
    expect(missing).toEqual({
      _tag: 'PaperRuntimeBindingUnavailable',
      operation: 'PREPARE',
      expectedMaximum: Authority.Observe,
      configuredMaximum: Authority.Paper,
      hasAccountBinding: false,
      hasQualificationBinding: false,
    })
    expect(capitalGrantFailureDetails(missing).message).toBe(
      'PAPER PREPARE requires the exact configured authority, account, generation, and qualification binding',
    )
    expect(
      failureOf(
        validatePaperPrepareGeneration(observeAuthority, {
          ...prepareBinding,
          configuredGenerationHash: hash('wrong-configured-generation'),
        }),
      ),
    ).toMatchObject({ _tag: 'PaperPrepareGenerationMismatch' })
    expect(
      failureOf(
        validatePaperSourceAuthority({
          ...observeAuthority,
          maximum: Authority.Paper,
          effective: Authority.Paper,
        }),
      ),
    ).toMatchObject({ _tag: 'PaperSourceAuthorityNotObserve' })
  })

  test('verifies exact terminal evidence and contains canonicalization failures', () => {
    expect(failureOf(validatePaperGenerationEvidence(undefined, prepareBinding, config.build))).toEqual({
      _tag: 'QualificationEvidenceUnavailable',
      qualificationRunId: prepareBinding.qualificationRunId,
    })
    expect(qualifiedAnalysis).toMatchObject({ status: 'PASS', reasonCodes: [] })
    expect(qualifiedResult).toMatchObject({ verdict: 'QUALIFIED', reasonCodes: [] })
    expect(successOf(validatePaperGenerationEvidence(evidence, prepareBinding, config.build))).toBe(evidence)
    expect(
      failureOf(
        validatePaperGenerationEvidence({ ...evidence, result: fixtureQualification }, prepareBinding, config.build),
      ),
    ).toMatchObject({
      _tag: 'QualificationEvidenceMismatch',
      qualificationRunId: prepareBinding.qualificationRunId,
    })

    interface RecursiveMaterial {
      self?: RecursiveMaterial
    }
    const recursive: RecursiveMaterial = {}
    recursive.self = recursive
    const failure = failureOf(
      validatePaperGenerationEvidence({ ...evidence, parameters: recursive }, prepareBinding, config.build),
    )
    expect(failure).toMatchObject({
      _tag: 'QualificationEvidenceVerificationFailed',
      operation: 'parameters',
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.self',
        reason: 'cycle',
      },
    })
    if (failure._tag !== 'QualificationEvidenceVerificationFailed') {
      throw new Error('expected qualification evidence verification failure')
    }
    const details = capitalGrantFailureDetails(failure)
    expect(details).toMatchObject({
      failure: 'invariant',
      message: 'PAPER qualification evidence parameters verification failed',
    })
    expect(details.cause).toBe(failure.cause)

    const accessCause = new Error('injected qualification evidence access failure')
    const accessFailure = failureOf(
      validatePaperGenerationEvidence(
        {
          ...evidence,
          get writingDetail(): unknown {
            throw accessCause
          },
        },
        prepareBinding,
        config.build,
      ),
    )
    expect(accessFailure).toEqual({
      _tag: 'QualificationEvidenceAccessFailed',
      qualificationRunId: prepareBinding.qualificationRunId,
      cause: accessCause,
    })
    expect(capitalGrantFailureDetails(accessFailure)).toEqual({
      failure: 'invariant',
      message: 'PAPER qualification evidence could not be read safely',
      cause: accessCause,
    })
  })

  test('derives stable generation identity from exact covered reconciliation facts', () => {
    expect(successOf(validateLatestExactReconciliation(reconciliation, accountId))).toBe(reconciliation)
    expect(
      successOf(
        validateMutationCoverage({ unresolvedCount: 0, latestMutationAt: reconciliation.reconciledAt }, reconciliation),
      ),
    ).toBeUndefined()
    const derived = successOf(
      deriveCapitalGrantGeneration({
        current: observeAuthority,
        proof,
        binding: prepareBinding,
        evidence,
        reconciliation,
        build: config.build,
      }),
    )
    const derivationCause = new Error('injected authority derivation defect')
    const derivationFailure = failureOf(
      deriveCapitalGrantGeneration({
        current: observeAuthority,
        proof,
        binding: prepareBinding,
        evidence,
        reconciliation,
        build: {
          get sourceRevision(): string {
            throw derivationCause
          },
          imageRepository: config.build.imageRepository,
          imageDigest: config.build.imageDigest,
          strategyBehaviorHash: config.build.strategyBehaviorHash,
          strategyParameterHash: config.build.strategyParameterHash,
        },
      }),
    )
    expect(derivationFailure).toEqual({ _tag: 'PaperGenerationDerivationFailed', cause: derivationCause })
    expect(capitalGrantFailureDetails(derivationFailure).cause).toBe(derivationCause)
    expect(
      failureOf(
        deriveCapitalGrantGeneration({
          current: observeAuthority,
          proof,
          binding: { ...prepareBinding, accountId: '' },
          evidence,
          reconciliation,
          build: config.build,
        }),
      ),
    ).toMatchObject({
      _tag: 'PaperGenerationDerivationFailed',
      cause: {
        _tag: 'CapitalGrantGenerationSchemaInvalid',
        operation: 'material',
      },
    })
    const refreshed = successOf(
      deriveCapitalGrantGeneration({
        current: observeAuthority,
        proof,
        binding: prepareBinding,
        evidence,
        reconciliation: {
          ...reconciliation,
          reconciliationId: hash('refreshed-reconciliation'),
          contentHash: hash('refreshed-reconciliation-content'),
        },
        build: config.build,
      }),
    )

    expect(derived.generation).toMatchObject({
      maximum: Authority.Paper,
      previousGenerationHash: observeGenerationHash,
      qualificationRunId: fixtureQualification.runId,
      accountId,
      riskPolicyHash: proof.riskPolicyHash,
      proofPlanHash: proof.proofPlanHash,
      reconciliationId: reconciliation.reconciliationId,
      reconciliationContentHash: reconciliation.contentHash,
    })
    expect(refreshed.generation.generationHash).toBe(derived.generation.generationHash)
    expect(
      failureOf(
        validateLatestExactReconciliation({ ...reconciliation, status: ReconciliationStatus.Discrepancy }, accountId),
      ),
    ).toMatchObject({ _tag: 'ExactReconciliationUnavailable' })
    expect(
      failureOf(validateMutationCoverage({ unresolvedCount: 1, latestMutationAt: null }, reconciliation)),
    ).toMatchObject({ _tag: 'MutationCoverageIncomplete', unresolvedCount: 1 })
    expect(
      failureOf(
        validatePaperGenerationFreshness(
          reconciliation,
          sqlTimestamp(reconciliation.reconciledAt.getTime() + config.reconciliationStaleThresholdMs),
          config.reconciliationStaleThresholdMs,
        ),
      ),
    ).toMatchObject({ _tag: 'ReconciliationNotFresh' })
  })

  test('decides activation replay byte-stably and preserves an active kill', () => {
    const derived = successOf(
      deriveCapitalGrantGeneration({
        current: observeAuthority,
        proof,
        binding: prepareBinding,
        evidence,
        reconciliation,
        build: config.build,
      }),
    )
    const activationBinding = {
      ...prepareBinding,
      configuredGenerationHash: derived.generation.generationHash,
    }
    const capitalGrant: AuthorityState = {
      ...observeAuthority,
      generationHash: derived.generation.generationHash,
      maximum: Authority.Paper,
      effective: Authority.Paper,
      version: 2,
      updatedAt: observedAt.toISOString(),
    }

    expect(successOf(nextAuthorityVersion(observeAuthority))).toBe(2)
    expect(successOf(decidePaperActivation(observeAuthority, activationBinding))).toEqual({
      _tag: 'ActivatePaperGeneration',
      current: observeAuthority,
      authorityVersion: 2,
    })
    const exhaustedAuthority = { ...observeAuthority, version: Number.MAX_SAFE_INTEGER }
    const exhausted = failureOf(decidePaperActivation(exhaustedAuthority, activationBinding))
    expect(exhausted).toEqual({
      _tag: 'AuthorityVersionExhausted',
      generationHash: observeGenerationHash,
      currentAuthorityVersion: Number.MAX_SAFE_INTEGER,
    })
    expect(capitalGrantFailureDetails(exhausted)).toEqual({
      failure: 'invariant',
      message: 'durable authority version is not a safe positive integer',
    })
    expect(successOf(validateDerivedPaperGeneration(derived.generation, activationBinding))).toBeUndefined()
    const prepared = {
      generationHash: derived.generation.generationHash,
      sourceGenerationHash: observeAuthority.generationHash,
    }
    expect(successOf(validatePreparedPaperActivation(observeAuthority, activationBinding, prepared))).toBeUndefined()
    expect(successOf(decidePaperActivation(capitalGrant, activationBinding))).toEqual({
      _tag: 'ReplayPaperGeneration',
      current: capitalGrant,
    })
    expect(successOf(validatePreparedPaperActivation(capitalGrant, activationBinding, prepared))).toBeUndefined()
    expect(
      failureOf(
        validatePreparedPaperActivation(
          { ...observeAuthority, generationHash: hash('post-prepare-observe-generation') },
          activationBinding,
          prepared,
        ),
      ),
    ).toMatchObject({
      _tag: 'PaperPrepareGenerationMismatch',
      configuredGenerationHash: observeAuthority.generationHash,
    })
    expect(
      failureOf(
        validatePreparedPaperActivation(observeAuthority, activationBinding, {
          ...prepared,
          generationHash: hash('different-prepared-generation'),
        }),
      ),
    ).toMatchObject({
      _tag: 'DerivedPaperGenerationMismatch',
      configuredGenerationHash: activationBinding.configuredGenerationHash,
    })
    expect(
      failureOf(
        decidePaperActivation(
          { ...capitalGrant, generationHash: hash('different-durable-paper-generation') },
          activationBinding,
        ),
      ),
    ).toMatchObject({
      _tag: 'DurablePaperGenerationMismatch',
      configuredGenerationHash: activationBinding.configuredGenerationHash,
    })
    expect(
      successOf(validatePaperGenerationReplay(derived.generation, activationBinding, proof, config.build)),
    ).toBeUndefined()
    expect(
      failureOf(
        validatePaperGenerationReplay(
          derived.generation,
          activationBinding,
          { ...proof, proofPlanHash: hash('changed-proof-plan') },
          config.build,
        ),
      ),
    ).toMatchObject({ _tag: 'PaperGenerationReplayMismatch' })
    expect(
      failureOf(
        validateDerivedPaperGeneration(derived.generation, {
          ...activationBinding,
          configuredGenerationHash: hash('different-derived-paper-generation'),
        }),
      ),
    ).toMatchObject({
      _tag: 'DerivedPaperGenerationMismatch',
      derivedGenerationHash: derived.generation.generationHash,
    })
    expect(paperActivationEffectiveAuthority(KillState.Clear)).toBe(Authority.Paper)
    expect(paperActivationEffectiveAuthority(KillState.Active)).toBe(Authority.Observe)
  })

  test('derives and replays a research PAPER generation without qualification evidence', () => {
    const research = researchProof()
    expect(
      successOf(
        validateResearchCapitalGrantProof({
          proof: research,
          sourceGenerationHash: observeGenerationHash,
          accountId,
          brokerIdentityHash: research.brokerIdentityHash,
          build: config.build,
        }),
      ),
    ).toBeUndefined()
    const derived = successOf(
      deriveResearchCapitalGrantGeneration({ current: observeAuthority, proof: research, reconciliation }),
    )
    expect(derived.generation).toMatchObject({
      schemaVersion: 'bayn.paper-authority-generation.v3',
      previousGenerationHash: observeGenerationHash,
      grant: research.grant,
      accountId,
    })
    expect(derived.generation.generationHash).toMatch(/^[0-9a-f]{64}$/)
    expect(
      successOf(validateResearchPaperGenerationReplay(derived.generation, research, observeGenerationHash)),
    ).toBeUndefined()
    expect(
      failureOf(
        validateResearchPaperGenerationReplay(
          derived.generation,
          { ...research, riskPolicyHash: hash('changed-risk-policy') },
          observeGenerationHash,
        ),
      ),
    ).toMatchObject({ _tag: 'ResearchPaperGenerationReplayMismatch' })
  })
})
