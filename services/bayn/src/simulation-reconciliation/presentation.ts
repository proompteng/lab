import { pipe, Result } from 'effect'

import { canonicalJsonV1Result, renderCanonicalJsonFailure } from '../hash'
import type { MarkedEquityProof, SimulationReconciliationIssue } from './model'

const renderEvidence = (value: unknown): string =>
  pipe(
    canonicalJsonV1Result(value),
    Result.match({
      onSuccess: (json) => json,
      onFailure: (failure) => `<unrenderable: ${renderCanonicalJsonFailure(failure)}>`,
    }),
  )

const renderSimulationReconciliationIssueUnsafe = (issue: SimulationReconciliationIssue): string => {
  switch (issue._tag) {
    case 'InvalidInteger':
      return `invalid integer (${issue.expected}): ${renderEvidence(issue.evidence)}`
    case 'InvalidIdentity':
      return issue.problem._tag === 'CanonicalizationFailed'
        ? `identity canonicalization failed for ${renderEvidence(issue.evidence)}: ${renderCanonicalJsonFailure(issue.problem.cause)}`
        : `invalid identity: ${renderEvidence({ evidence: issue.evidence, problem: issue.problem })}`
    case 'MissingReference':
      return `missing reference: ${renderEvidence(issue.problem)}`
    case 'EvidenceMismatch':
      return `evidence mismatch: ${renderEvidence(issue.problem)}`
    case 'InvalidEvidenceState':
      return `invalid evidence state: ${renderEvidence(issue.problem)}`
    case 'IncompleteEvidence':
      return `incomplete evidence: ${renderEvidence(issue.problem)}`
    case 'ComputationFailed':
      return `${issue.computation._tag} calculation failed for ${renderEvidence(issue.computation)}: ${issue.cause._tag}`
  }
}

export const renderSimulationReconciliationIssue = (issue: SimulationReconciliationIssue): string =>
  pipe(
    Result.try(() => renderSimulationReconciliationIssueUnsafe(issue)),
    Result.getOrElse(() => 'unrenderable simulation reconciliation issue'),
  )

export const renderSimulationReconciliationIssues = (issues: readonly SimulationReconciliationIssue[]): string =>
  pipe(
    Result.try(() => issues.map(renderSimulationReconciliationIssue).join('; ')),
    Result.getOrElse(() => 'unrenderable simulation reconciliation issues'),
  )

const freezePublicIssue = (issue: SimulationReconciliationIssue): SimulationReconciliationIssue => {
  switch (issue._tag) {
    case 'InvalidInteger':
      return Object.freeze(Object.assign({}, issue, { evidence: Object.freeze({ ...issue.evidence }) }))
    case 'InvalidIdentity':
      return Object.freeze(
        Object.assign({}, issue, {
          evidence: Object.freeze({ ...issue.evidence }),
          problem: Object.freeze({ ...issue.problem }),
        }),
      )
    case 'MissingReference':
    case 'EvidenceMismatch':
    case 'IncompleteEvidence':
      return Object.freeze(Object.assign({}, issue, { problem: Object.freeze({ ...issue.problem }) }))
    case 'InvalidEvidenceState':
      return issue.problem._tag === 'DuplicateMarkedPosition' || issue.problem._tag === 'UnsortedMarkedPositions'
        ? Object.freeze(
            Object.assign({}, issue, {
              problem: Object.freeze({ ...issue.problem, symbols: Object.freeze([...issue.problem.symbols]) }),
            }),
          )
        : Object.freeze(Object.assign({}, issue, { problem: Object.freeze({ ...issue.problem }) }))
    case 'ComputationFailed':
      return Object.freeze(Object.assign({}, issue, { computation: Object.freeze({ ...issue.computation }) }))
  }
}

export const freezePublicIssues = (
  issues: readonly SimulationReconciliationIssue[],
): readonly SimulationReconciliationIssue[] => Object.freeze(issues.map(freezePublicIssue))

export const freezePublicProof = (proof: MarkedEquityProof): MarkedEquityProof =>
  Object.freeze({
    reconciliation: Object.freeze({ ...proof.reconciliation }),
    equitySeries: Object.freeze(proof.equitySeries.map((point) => Object.freeze({ ...point }))),
  })
