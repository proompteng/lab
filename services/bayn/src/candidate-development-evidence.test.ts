import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  candidate17DevelopmentEligibility,
  candidate17DevelopmentEvidenceExpectation,
  candidate17Preregistration,
  candidate19DevelopmentFailureEvidenceExpectation,
  candidate20Preregistration,
  frozenCandidateDevelopmentTrialHistory,
} from './candidate-development-calendar'
import {
  candidate17DevelopmentEvidenceResult,
  candidate17DevelopmentIndependentReproductionResult,
} from './candidate-development-candidate-17-evidence'
import { deriveCandidateDevelopmentDecision } from './candidate-development-decision'
import {
  candidateDevelopmentDecisionOutputMaterial,
  decideCandidateDevelopmentEligibility,
  decideCandidateDevelopmentEligibilityFromUnknown,
  validateCandidateDevelopmentIndependentReproduction,
  withCandidateDevelopmentQualificationAuthorization,
  type CandidateDevelopmentEvidenceExpectation,
  type CandidateDevelopmentEvidenceIssue,
  type CandidateDevelopmentImmutableEvidence,
} from './candidate-development-evidence'
import { canonicalHashV1 } from './hash'
import type { QualificationSelectedBenchmarkComparisonAnalysis } from './qualification-statistics'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error('expected Candidate 17 evidence decode success')
  return result.success
}

const candidate17DevelopmentEvidence = successOf(candidate17DevelopmentEvidenceResult)
const candidate17DevelopmentIndependentReproduction = successOf(candidate17DevelopmentIndependentReproductionResult)

const candidate17ValidatedEligibility = decideCandidateDevelopmentEligibility(
  candidate17DevelopmentEvidence,
  candidate17DevelopmentEvidenceExpectation,
  candidate17Preregistration,
)

const selfExpectation = (evidence: CandidateDevelopmentImmutableEvidence): CandidateDevelopmentEvidenceExpectation => ({
  bindings: evidence.bindings,
  evidenceContentHash: evidence.contentHash,
  independentlyReproducedEvaluationHash:
    candidate17DevelopmentEvidenceExpectation.independentlyReproducedEvaluationHash,
  independentlyReproducedDecisionOutputHash:
    candidate17DevelopmentEvidenceExpectation.independentlyReproducedDecisionOutputHash,
})

const rehashEvidence = (mutate: (evidence: Record<string, any>) => void): CandidateDevelopmentImmutableEvidence => {
  const evidence = structuredClone(candidate17DevelopmentEvidence) as unknown as Record<string, any>
  mutate(evidence)
  const { contentHash: _, ...material } = evidence
  evidence.contentHash = canonicalHashV1(material)
  return evidence as unknown as CandidateDevelopmentImmutableEvidence
}

const invalidIssue = (
  evidence: CandidateDevelopmentImmutableEvidence,
  tag: CandidateDevelopmentEvidenceIssue['_tag'],
): boolean => {
  const decision = decideCandidateDevelopmentEligibility(
    evidence,
    selfExpectation(evidence),
    candidate17Preregistration,
  )
  expect(decision).toMatchObject({ status: 'DEVELOPMENT_EVIDENCE_INVALID', nextCandidatePreregistration: null })
  return decision.status === 'DEVELOPMENT_EVIDENCE_INVALID' && decision.issues.some((issue) => issue._tag === tag)
}

const passingAnalysis = (): QualificationSelectedBenchmarkComparisonAnalysis => {
  const analysis = structuredClone(
    candidate17DevelopmentEvidence.evaluation.comparisonSemantics.analysis,
  ) as unknown as Record<string, any>
  analysis.power.sufficient = true
  analysis.bootstrap.tailResolutionSufficient = true
  analysis.bootstrap.annualizedReturnDifferenceLowerBound = 0.01
  analysis.bootstrap.sharpeDifferenceLowerBound = 0.01
  analysis.walkForward.folds = analysis.walkForward.folds.map((fold: Record<string, any>, ordinal: number) => ({
    ...fold,
    ordinal,
    strategyReturn: 0.1,
    selectedBenchmarkReturn: 0.05,
    returnDifference: 0.05,
    maximumDrawdown: 0.1,
    positiveDifference: true,
    drawdownWithinLimit: true,
  }))
  analysis.walkForward.positiveFolds = analysis.walkForward.folds.length
  analysis.walkForward.positiveFoldFraction = 1
  analysis.walkForward.allDrawdownsWithinLimit = true
  analysis.walkForward.maximumFoldDrawdown = 0.1
  analysis.walkForward.sufficient = true
  return analysis as unknown as QualificationSelectedBenchmarkComparisonAnalysis
}

describe('candidate development immutable evidence gate', () => {
  test('requires every existing development gate for a pure PASS decision', () => {
    const comparison = passingAnalysis()
    const passed = deriveCandidateDevelopmentDecision({
      comparison,
      doubledCostAnnualizedReturn: 0.1,
      economicPass: true,
      baselineTerminalCash: true,
      stressedTerminalCash: true,
    })
    expect(passed.status).toBe('PASS')
    expect(passed.gates.every((gate) => gate.passed)).toBe(true)

    const failures = [
      {
        comparison,
        doubledCostAnnualizedReturn: -0.01,
        economicPass: true,
        baselineTerminalCash: true,
        stressedTerminalCash: true,
      },
      {
        comparison: {
          ...comparison,
          bootstrap: { ...comparison.bootstrap, annualizedReturnDifferenceLowerBound: 0 },
        },
        doubledCostAnnualizedReturn: 0.1,
        economicPass: true,
        baselineTerminalCash: true,
        stressedTerminalCash: true,
      },
      {
        comparison: {
          ...comparison,
          bootstrap: { ...comparison.bootstrap, sharpeDifferenceLowerBound: 0 },
        },
        doubledCostAnnualizedReturn: 0.1,
        economicPass: true,
        baselineTerminalCash: true,
        stressedTerminalCash: true,
      },
      {
        comparison: { ...comparison, power: { ...comparison.power, sufficient: false } },
        doubledCostAnnualizedReturn: 0.1,
        economicPass: true,
        baselineTerminalCash: true,
        stressedTerminalCash: true,
      },
      {
        comparison: {
          ...comparison,
          walkForward: { ...comparison.walkForward, positiveFoldFraction: 0.4 },
        },
        doubledCostAnnualizedReturn: 0.1,
        economicPass: true,
        baselineTerminalCash: true,
        stressedTerminalCash: true,
      },
      {
        comparison,
        doubledCostAnnualizedReturn: 0.1,
        economicPass: false,
        baselineTerminalCash: true,
        stressedTerminalCash: true,
      },
    ] as const
    for (const failure of failures) expect(deriveCandidateDevelopmentDecision(failure).status).toBe('HOLD_REJECT')
  })

  test('binds the complete evaluation and decision output reproduced by the reviewed module', () => {
    const reproduced = candidate17DevelopmentIndependentReproduction.evaluation
    expect(canonicalHashV1(reproduced)).toBe(
      candidate17DevelopmentEvidenceExpectation.independentlyReproducedEvaluationHash,
    )
    expect(canonicalHashV1(candidateDevelopmentDecisionOutputMaterial(reproduced))).toBe(
      candidate17DevelopmentEvidenceExpectation.independentlyReproducedDecisionOutputHash,
    )
    expect(canonicalHashV1(reproduced)).toBe(canonicalHashV1(candidate17DevelopmentEvidence.evaluation))
    expect(
      validateCandidateDevelopmentIndependentReproduction(
        candidate17DevelopmentEvidence,
        candidate17DevelopmentEvidenceExpectation,
        candidate17DevelopmentIndependentReproduction,
      ),
    ).toEqual([])
  }, 30_000)

  test('rejects hindsight decisions that the reviewed module did not reproduce', () => {
    const hindsight = rehashEvidence((record) => {
      const baseline = record.evaluation.baseline.signalDecisions[0]
      const stressed = record.evaluation.stressed.signalDecisions[0]
      baseline.targetWeights = { ...baseline.targetWeights, SPY: 0.99 }
      stressed.targetWeights = { ...stressed.targetWeights, SPY: 0.99 }
    })
    const issues = validateCandidateDevelopmentIndependentReproduction(
      hindsight,
      selfExpectation(hindsight),
      candidate17DevelopmentIndependentReproduction,
    )
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _tag: 'CandidateDevelopmentEvidenceBindingMismatch',
          field: 'reproduction.evaluation',
        }),
      ]),
    )
  })

  test('recomputes economic metrics from complete equity and accounting evidence', () => {
    const evidence = rehashEvidence((record) => {
      record.evaluation.baseline.strategy = {
        ...record.evaluation.baseline.strategy,
        totalReturn: -0.5,
        annualizedReturn: 0.5,
        sharpe: 2,
        maximumDrawdown: 0.01,
      }
      record.evaluation.baseline.verdict.status = 'PASS'
      for (const gate of record.evaluation.baseline.verdict.gates) gate.passed = true
    })
    expect(invalidIssue(evidence, 'CandidateDevelopmentEvidenceEconomicInvalid')).toBe(true)
  })

  test('recomputes bootstrap distributions, hashes, quantiles, and power from the bound series', () => {
    const forgedBootstrap = rehashEvidence((record) => {
      const bootstrap = record.evaluation.comparisonSemantics.analysis.bootstrap
      bootstrap.annualizedReturnDifferenceSamples = bootstrap.annualizedReturnDifferenceSamples.map(() => 1)
      bootstrap.sharpeDifferenceSamples = bootstrap.sharpeDifferenceSamples.map(() => 1)
      bootstrap.annualizedReturnDifferenceLowerBound = 1
      bootstrap.sharpeDifferenceLowerBound = 1
      bootstrap.samplesHash = 'f'.repeat(64)
      record.evaluation.comparisonSemantics.analysis.analysisHash = 'e'.repeat(64)
    })
    expect(invalidIssue(forgedBootstrap, 'CandidateDevelopmentEvidenceComparisonInvalid')).toBe(true)

    const forgedPower = rehashEvidence((record) => {
      const power = record.evaluation.comparisonSemantics.analysis.power
      power.availableCompleteRebalanceBlocks = 0
      power.availableCompleteSessions = 0
      power.sufficient = true
      record.evaluation.comparisonSemantics.analysis.analysisHash = 'd'.repeat(64)
    })
    expect(invalidIssue(forgedPower, 'CandidateDevelopmentEvidenceComparisonInvalid')).toBe(true)
  }, 30_000)

  test('enforces policy-selected benchmark and expanding-origin fold geometry', () => {
    const forgedBenchmark = rehashEvidence((record) => {
      const analysis = record.evaluation.comparisonSemantics.analysis
      analysis.bootstrap.selectedBenchmark = 'direct-volatility-timing'
      analysis.walkForward.selectedBenchmark = 'direct-volatility-timing'
      for (const fold of analysis.walkForward.folds) {
        fold.selectedBenchmark = 'direct-volatility-timing'
        fold.selectedBenchmarkReturn = -0.5
        fold.returnDifference = 0.5
        fold.positiveDifference = true
      }
      analysis.walkForward.positiveFolds = analysis.walkForward.folds.length
      analysis.walkForward.positiveFoldFraction = 1
      analysis.analysisHash = 'c'.repeat(64)
    })
    expect(invalidIssue(forgedBenchmark, 'CandidateDevelopmentEvidenceComparisonInvalid')).toBe(true)

    const forgedGeometry = rehashEvidence((record) => {
      const analysis = record.evaluation.comparisonSemantics.analysis
      const first = analysis.walkForward.folds[0]
      analysis.walkForward.folds = analysis.walkForward.folds.map((fold: Record<string, any>, ordinal: number) => ({
        ...fold,
        ordinal,
        trainingStart: first.trainingStart,
        trainingEnd: first.trainingEnd,
        testStart: first.testStart,
        testEnd: first.testStart,
        testObservationCount: 1,
      }))
      analysis.analysisHash = 'b'.repeat(64)
    })
    expect(invalidIssue(forgedGeometry, 'CandidateDevelopmentEvidenceComparisonInvalid')).toBe(true)
  }, 30_000)

  test('revalidates the baseline and stressed doubled-cost causal paths', () => {
    const evidence = rehashEvidence((record) => {
      const order = record.evaluation.stressed.simulation.orders.find(
        (candidate: Record<string, any>) => candidate.filledQuantityMicros !== '0',
      )
      if (order === undefined) throw new Error('Candidate 17 stressed evidence must contain a nonzero order')
      order.requestedQuantityMicros = (BigInt(order.requestedQuantityMicros) + 1n).toString()
      order.filledQuantityMicros = (BigInt(order.filledQuantityMicros) + 1n).toString()
    })
    expect(invalidIssue(evidence, 'CandidateDevelopmentEvidenceDoubledCostInvalid')).toBe(true)
  })

  test('fails closed on missing, malformed, tampered, stale, or mismatched evidence', () => {
    const malformed = structuredClone(candidate17DevelopmentEvidence) as unknown as Record<string, any>
    delete malformed.bindings.schemaVersion
    malformed.evaluation.baseline.strategy.annualizedReturn = 'not-a-number'
    const malformedDecision = decideCandidateDevelopmentEligibilityFromUnknown(
      malformed,
      candidate17DevelopmentEvidenceExpectation,
      candidate17Preregistration,
    )
    expect(malformedDecision).toMatchObject({
      status: 'DEVELOPMENT_EVIDENCE_INVALID',
      issues: [{ _tag: 'CandidateDevelopmentEvidenceDecodeFailed' }],
      nextCandidatePreregistration: null,
    })

    const missing = decideCandidateDevelopmentEligibility(
      null,
      candidate17DevelopmentEvidenceExpectation,
      candidate17Preregistration,
    )
    expect(missing).toMatchObject({ status: 'DEVELOPMENT_EVIDENCE_INVALID', nextCandidatePreregistration: null })

    const tampered = structuredClone(candidate17DevelopmentEvidence) as unknown as Record<string, any>
    tampered.evaluation.baseline.strategy.annualizedReturn = 1
    expect(
      decideCandidateDevelopmentEligibility(
        tampered as unknown as CandidateDevelopmentImmutableEvidence,
        candidate17DevelopmentEvidenceExpectation,
        candidate17Preregistration,
      ),
    ).toMatchObject({ status: 'DEVELOPMENT_EVIDENCE_INVALID', nextCandidatePreregistration: null })

    const stale = rehashEvidence((record) => {
      record.bindings.mergedSourceRevision = 'f'.repeat(40)
    })
    expect(
      decideCandidateDevelopmentEligibility(
        stale,
        candidate17DevelopmentEvidenceExpectation,
        candidate17Preregistration,
      ),
    ).toMatchObject({ status: 'DEVELOPMENT_EVIDENCE_INVALID', nextCandidatePreregistration: null })

    const mismatchedPreregistration = { ...candidate17Preregistration, moduleSha256: '0'.repeat(64) }
    expect(
      decideCandidateDevelopmentEligibility(
        candidate17DevelopmentEvidence,
        candidate17DevelopmentEvidenceExpectation,
        mismatchedPreregistration,
      ),
    ).toMatchObject({ status: 'DEVELOPMENT_EVIDENCE_INVALID', nextCandidatePreregistration: null })
  }, 30_000)

  test('preserves Candidate 17 and 18 rejection and terminalizes Candidate 19 without consuming qualification', () => {
    expect(candidate17ValidatedEligibility).toMatchObject({
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: candidate17DevelopmentEligibility.evidenceContentHash,
      nextCandidatePreregistration: null,
    })
    expect(candidate17DevelopmentEligibility).toEqual({
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: candidate17DevelopmentEvidenceExpectation.evidenceContentHash,
      nextCandidatePreregistration: null,
    })
    expect(frozenCandidateDevelopmentTrialHistory.completedCandidateOrdinals).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ])
    expect(frozenCandidateDevelopmentTrialHistory.latestDevelopmentEvidence).toMatchObject({
      candidateOrdinal: 19,
      priorTrialCount: 18,
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: candidate19DevelopmentFailureEvidenceExpectation.evidenceContentHash,
      evaluatedSourceRevision: candidate19DevelopmentFailureEvidenceExpectation.evaluatedSourceRevision,
      failureStage: 'development-evaluation',
      developmentMetricsObserved: true,
      qualificationAttemptConsumed: false,
    })
    expect(frozenCandidateDevelopmentTrialHistory.developmentCandidateOrdinals).toEqual([17, 18, 19])
    expect(frozenCandidateDevelopmentTrialHistory.latestReviewedCandidatePreregistration).toEqual(
      candidate20Preregistration,
    )
    expect(frozenCandidateDevelopmentTrialHistory.nextCandidatePreregistration).toBeNull()
    expect(Math.max(...frozenCandidateDevelopmentTrialHistory.completedCandidateOrdinals)).toBe(16)
  })

  test('does not call a holdout loader for rejected, missing, or stale evidence', () => {
    let calls = 0
    const loadHoldout = () => {
      calls += 1
      return 'holdout'
    }
    const rejected = withCandidateDevelopmentQualificationAuthorization(candidate17ValidatedEligibility, loadHoldout)
    const missing = withCandidateDevelopmentQualificationAuthorization(
      decideCandidateDevelopmentEligibility(
        null,
        candidate17DevelopmentEvidenceExpectation,
        candidate17Preregistration,
      ),
      loadHoldout,
    )
    const staleEvidence = rehashEvidence((record) => {
      record.bindings.strategyProtocolHash = '0'.repeat(64)
    })
    const stale = withCandidateDevelopmentQualificationAuthorization(
      decideCandidateDevelopmentEligibility(
        staleEvidence,
        candidate17DevelopmentEvidenceExpectation,
        candidate17Preregistration,
      ),
      loadHoldout,
    )

    expect(rejected).toMatchObject({ status: 'BLOCKED', reason: 'DEVELOPMENT_REJECTED' })
    expect(missing).toMatchObject({ status: 'BLOCKED', reason: 'DEVELOPMENT_EVIDENCE_INVALID' })
    expect(stale).toMatchObject({ status: 'BLOCKED', reason: 'DEVELOPMENT_EVIDENCE_INVALID' })
    expect(calls).toBe(0)
  })
})
