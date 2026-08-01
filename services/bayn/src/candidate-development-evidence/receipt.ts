import { Result } from 'effect'

import { buildCandidateDevelopmentCommandReport } from '../candidate-development-command'
import type { CandidateDevelopmentNextPreregistration } from '../candidate-development-decision'
import { collectCandidateDevelopmentEligibilityBindings, collectCanonicalBinding } from './bindings'
import { validateCandidateDevelopmentCompleteEvidence } from './accounting'
import {
  buildCandidateDevelopmentIndependentReproduction,
  candidateDevelopmentDecisionOutputMaterial,
  collectCandidateDevelopmentEvidenceHashIssues,
  validateCandidateDevelopmentIndependentReproduction,
} from './hashing'
import type {
  CandidateDevelopmentEvidenceExpectation,
  CandidateDevelopmentEvidenceIssue,
  CandidateDevelopmentEligibilityDecision,
  CandidateDevelopmentImmutableEvidence,
  CandidateDevelopmentIndependentReproduction,
  CandidateDevelopmentQualificationAuthorization,
} from './model'
import { decodeCandidateDevelopmentImmutableEvidence } from './wire'

export { buildCandidateDevelopmentIndependentReproduction, candidateDevelopmentDecisionOutputMaterial }
export { validateCandidateDevelopmentIndependentReproduction }

export const withCandidateDevelopmentQualificationAuthorization = <A>(
  decision: CandidateDevelopmentEligibilityDecision,
  loadQualificationInput: (preregistration: CandidateDevelopmentNextPreregistration) => A,
): CandidateDevelopmentQualificationAuthorization<A> =>
  decision.status === 'DEVELOPMENT_APPROVED'
    ? { status: 'AUTHORIZED', value: loadQualificationInput(decision.nextCandidatePreregistration) }
    : { status: 'BLOCKED', reason: decision.status }

export const decideCandidateDevelopmentEligibility = (
  evidence: CandidateDevelopmentImmutableEvidence | null,
  expectation: CandidateDevelopmentEvidenceExpectation,
  preregistration: CandidateDevelopmentNextPreregistration,
  reproduction: CandidateDevelopmentIndependentReproduction | null = null,
): CandidateDevelopmentEligibilityDecision => {
  if (evidence === null) {
    return {
      status: 'DEVELOPMENT_EVIDENCE_INVALID',
      issues: [{ _tag: 'CandidateDevelopmentEvidenceMissing' }],
      nextCandidatePreregistration: null,
    }
  }

  const issues: CandidateDevelopmentEvidenceIssue[] = []
  collectCandidateDevelopmentEvidenceHashIssues(issues, evidence, expectation)
  collectCandidateDevelopmentEligibilityBindings(issues, evidence, expectation, preregistration)

  const complete = validateCandidateDevelopmentCompleteEvidence(evidence)
  issues.push(...complete.issues)
  if (issues.length > 0 || complete.value === null) {
    return { status: 'DEVELOPMENT_EVIDENCE_INVALID', issues, nextCandidatePreregistration: null }
  }

  if (complete.value.decision.status === 'HOLD_REJECT') {
    return {
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: evidence.contentHash,
      decision: complete.value.decision,
      nextCandidatePreregistration: null,
    }
  }

  if (reproduction === null) {
    return {
      status: 'DEVELOPMENT_EVIDENCE_INVALID',
      issues: [{ _tag: 'CandidateDevelopmentEvidenceReproductionMissing' }],
      nextCandidatePreregistration: null,
    }
  }
  const reproductionIssues = validateCandidateDevelopmentIndependentReproduction(evidence, expectation, reproduction)
  if (reproductionIssues.length > 0) {
    return {
      status: 'DEVELOPMENT_EVIDENCE_INVALID',
      issues: reproductionIssues,
      nextCandidatePreregistration: null,
    }
  }

  const approval = buildCandidateDevelopmentCommandReport(
    complete.value.development,
    complete.value.evaluation,
    evidence.strategyProtocol,
    evidence.input.officialSessions,
    evidence.verifiedSource,
  )
  if (Result.isFailure(approval) || approval.success.decision.status !== 'PASS') {
    return {
      status: 'DEVELOPMENT_EVIDENCE_INVALID',
      issues: [
        {
          _tag: 'CandidateDevelopmentEvidenceApprovalInvalid',
          cause: Result.isFailure(approval) ? approval.failure : approval.success.decision,
        },
      ],
      nextCandidatePreregistration: null,
    }
  }
  collectCanonicalBinding(issues, 'approval.decision', complete.value.decision, approval.success.decision)
  if (issues.length > 0) {
    return { status: 'DEVELOPMENT_EVIDENCE_INVALID', issues, nextCandidatePreregistration: null }
  }
  return {
    status: 'DEVELOPMENT_APPROVED',
    evidenceContentHash: evidence.contentHash,
    decision: complete.value.decision,
    nextCandidatePreregistration: preregistration,
  }
}

export const decideCandidateDevelopmentEligibilityFromUnknown = (
  value: unknown,
  expectation: CandidateDevelopmentEvidenceExpectation,
  preregistration: CandidateDevelopmentNextPreregistration,
  reproduction: CandidateDevelopmentIndependentReproduction | null = null,
): CandidateDevelopmentEligibilityDecision => {
  if (value === null) return decideCandidateDevelopmentEligibility(null, expectation, preregistration, reproduction)
  const decoded = decodeCandidateDevelopmentImmutableEvidence(value)
  return Result.isFailure(decoded)
    ? {
        status: 'DEVELOPMENT_EVIDENCE_INVALID',
        issues: [decoded.failure],
        nextCandidatePreregistration: null,
      }
    : decideCandidateDevelopmentEligibility(decoded.success, expectation, preregistration, reproduction)
}
