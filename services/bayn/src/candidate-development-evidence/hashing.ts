import { Result } from 'effect'

import { validateCandidateDevelopmentCommandEvaluation } from '../candidate-development-command'
import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import { collectCanonicalBinding, collectCanonicalBindings } from './bindings'
import type {
  CandidateDevelopmentEvidenceExpectation,
  CandidateDevelopmentEvidenceIssue,
  CandidateDevelopmentImmutableEvidence,
  CandidateDevelopmentIndependentReproduction,
} from './model'
import type {
  CandidateDevelopmentCommandEvaluation,
  CandidateDevelopmentVerifiedSource,
} from '../candidate-development-command'

export const candidateDevelopmentEvidenceMaterial = (
  evidence: CandidateDevelopmentImmutableEvidence,
): Omit<CandidateDevelopmentImmutableEvidence, 'contentHash'> => {
  const { contentHash: _, ...material } = evidence
  return material
}

export const candidateDevelopmentDecisionOutputMaterial = (evaluation: CandidateDevelopmentCommandEvaluation) => ({
  schemaVersion: 'bayn.candidate-development-decision-output.v1' as const,
  baselineRunId: evaluation.baseline.runId,
  stressedRunId: evaluation.accounting.stressedRunId,
  baseline: {
    signalDecisions: evaluation.baseline.signalDecisions,
    orders: evaluation.baseline.simulation.orders,
  },
  stressed: {
    signalDecisions: evaluation.stressed.signalDecisions,
    orders: evaluation.stressed.simulation.orders,
  },
})

const hashFailureIssue = (cause: CanonicalHashFailure): CandidateDevelopmentEvidenceIssue => ({
  _tag: 'CandidateDevelopmentEvidenceHashFailed',
  cause,
})

export const collectCandidateDevelopmentEvidenceHashIssues = (
  issues: CandidateDevelopmentEvidenceIssue[],
  evidence: CandidateDevelopmentImmutableEvidence,
  expectation: CandidateDevelopmentEvidenceExpectation,
): void => {
  const computedHash = canonicalHashV1Result(candidateDevelopmentEvidenceMaterial(evidence))
  if (Result.isFailure(computedHash)) {
    issues.push(hashFailureIssue(computedHash.failure))
  } else {
    if (computedHash.success !== evidence.contentHash) {
      issues.push({
        _tag: 'CandidateDevelopmentEvidenceContentHashMismatch',
        expected: computedHash.success,
        observed: evidence.contentHash,
      })
    }
    if (evidence.contentHash !== expectation.evidenceContentHash) {
      issues.push({
        _tag: 'CandidateDevelopmentEvidenceContentHashMismatch',
        expected: expectation.evidenceContentHash,
        observed: evidence.contentHash,
      })
    }
  }

  const evaluationHash = canonicalHashV1Result(evidence.evaluation)
  if (Result.isFailure(evaluationHash)) {
    issues.push(hashFailureIssue(evaluationHash.failure))
  } else if (evaluationHash.success !== expectation.independentlyReproducedEvaluationHash) {
    issues.push({
      _tag: 'CandidateDevelopmentEvidenceReproductionMismatch',
      field: 'evaluation',
      expected: expectation.independentlyReproducedEvaluationHash,
      observed: evaluationHash.success,
    })
  }

  const decisionOutputHash = canonicalHashV1Result(candidateDevelopmentDecisionOutputMaterial(evidence.evaluation))
  if (Result.isFailure(decisionOutputHash)) {
    issues.push(hashFailureIssue(decisionOutputHash.failure))
  } else if (decisionOutputHash.success !== expectation.independentlyReproducedDecisionOutputHash) {
    issues.push({
      _tag: 'CandidateDevelopmentEvidenceReproductionMismatch',
      field: 'decisionOutput',
      expected: expectation.independentlyReproducedDecisionOutputHash,
      observed: decisionOutputHash.success,
    })
  }
}

export const buildCandidateDevelopmentIndependentReproduction = (
  verifiedSource: CandidateDevelopmentVerifiedSource,
  evaluation: CandidateDevelopmentCommandEvaluation,
): Result.Result<CandidateDevelopmentIndependentReproduction, CandidateDevelopmentEvidenceIssue> => {
  const evaluationHash = canonicalHashV1Result(evaluation)
  if (Result.isFailure(evaluationHash)) return Result.fail(hashFailureIssue(evaluationHash.failure))

  const decisionOutputHash = canonicalHashV1Result(candidateDevelopmentDecisionOutputMaterial(evaluation))
  if (Result.isFailure(decisionOutputHash)) return Result.fail(hashFailureIssue(decisionOutputHash.failure))

  return Result.succeed({
    schemaVersion: 'bayn.candidate-development-independent-reproduction.v1',
    sourceRevision: verifiedSource.sourceRevision,
    modulePath: verifiedSource.modulePath,
    moduleBlobOid: verifiedSource.moduleBlobOid,
    moduleSha256: verifiedSource.moduleSha256,
    evaluation,
    evaluationHash: evaluationHash.success,
    decisionOutputHash: decisionOutputHash.success,
  })
}

export const validateCandidateDevelopmentIndependentReproduction = (
  evidence: CandidateDevelopmentImmutableEvidence,
  expectation: CandidateDevelopmentEvidenceExpectation,
  reproduction: CandidateDevelopmentIndependentReproduction,
): readonly CandidateDevelopmentEvidenceIssue[] => {
  const decoded = validateCandidateDevelopmentCommandEvaluation(reproduction.evaluation)
  if (Result.isFailure(decoded)) {
    return [{ _tag: 'CandidateDevelopmentEvidenceReproductionFailed', cause: decoded.failure }]
  }

  const issues: CandidateDevelopmentEvidenceIssue[] = []
  collectCanonicalBindings(issues, [
    ['sourceRevision', evidence.verifiedSource.sourceRevision, reproduction.sourceRevision],
    ['modulePath', evidence.verifiedSource.modulePath, reproduction.modulePath],
    ['moduleBlobOid', evidence.verifiedSource.moduleBlobOid, reproduction.moduleBlobOid],
    ['moduleSha256', evidence.verifiedSource.moduleSha256, reproduction.moduleSha256],
  ])

  const reproducedEvaluationHash = canonicalHashV1Result(decoded.success)
  if (Result.isFailure(reproducedEvaluationHash)) {
    issues.push(hashFailureIssue(reproducedEvaluationHash.failure))
  } else {
    for (const expected of [expectation.independentlyReproducedEvaluationHash, reproduction.evaluationHash]) {
      if (expected !== reproducedEvaluationHash.success) {
        issues.push({
          _tag: 'CandidateDevelopmentEvidenceReproductionMismatch',
          field: 'evaluation',
          expected,
          observed: reproducedEvaluationHash.success,
        })
      }
    }
  }

  const reproducedDecisionOutputHash = canonicalHashV1Result(
    candidateDevelopmentDecisionOutputMaterial(decoded.success),
  )
  if (Result.isFailure(reproducedDecisionOutputHash)) {
    issues.push(hashFailureIssue(reproducedDecisionOutputHash.failure))
  } else {
    for (const expected of [expectation.independentlyReproducedDecisionOutputHash, reproduction.decisionOutputHash]) {
      if (expected !== reproducedDecisionOutputHash.success) {
        issues.push({
          _tag: 'CandidateDevelopmentEvidenceReproductionMismatch',
          field: 'decisionOutput',
          expected,
          observed: reproducedDecisionOutputHash.success,
        })
      }
    }
  }

  collectCanonicalBinding(issues, 'reproduction.evaluation', evidence.evaluation, decoded.success)
  return issues
}
