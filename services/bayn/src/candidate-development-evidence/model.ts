import type {
  CandidateDevelopmentPreflightInput,
  CandidateDevelopmentPreflightPass,
  CandidateDevelopmentReport,
} from '../candidate-development'
import type { candidateDevelopmentCalendarContract } from '../candidate-development'
import type {
  CandidateDevelopmentCommandEvaluation,
  CandidateDevelopmentStrategyProtocol,
  CandidateDevelopmentVerifiedSource,
} from '../candidate-development-command'
import type {
  CandidateDevelopmentDecision,
  CandidateDevelopmentNextPreregistration,
} from '../candidate-development-decision'
import type { CanonicalHashFailure } from '../hash'

export interface CandidateDevelopmentEvidenceBindings {
  readonly schemaVersion: 'bayn.candidate-development-evidence-bindings.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly preregistration: CandidateDevelopmentNextPreregistration['preregistration']
  readonly reviewedSourceRevision: string
  readonly mergedSourceRevision: string
  readonly module: {
    readonly path: string
    readonly blobOid: string
    readonly sha256: string
  }
  readonly sourceManifest: {
    readonly path: string
    readonly blobOid: string
    readonly sha256: string
  }
  readonly strategyProtocolHash: string
  readonly candidateDevelopmentProtocolHash: string
  readonly marketData: CandidateDevelopmentNextPreregistration['marketData']
  readonly calendar: typeof candidateDevelopmentCalendarContract
}

export interface CandidateDevelopmentReviewedTerminalSummary {
  readonly schemaVersion: 'bayn.candidate-development-reviewed-terminal-summary.v1'
  readonly source: 'reviewed-development-only-evaluation'
  readonly strategyAnnualizedReturn: number
  readonly buyAndHoldAnnualizedReturn: number
  readonly annualizedReturnDifferenceLowerBound: number
  readonly sharpeDifferenceLowerBound: number
  readonly verdict: 'PASS' | 'FAIL_CLOSED'
  readonly researchContext: readonly [
    'https://doi.org/10.1111/1468-0262.00152',
    'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253',
  ]
}

export interface CandidateDevelopmentImmutableEvidence {
  readonly schemaVersion: 'bayn.candidate-development-immutable-evidence.v2'
  readonly recordedAt: string
  readonly bindings: CandidateDevelopmentEvidenceBindings
  readonly input: CandidateDevelopmentPreflightInput
  readonly verifiedSource: CandidateDevelopmentVerifiedSource
  readonly strategyProtocol: CandidateDevelopmentStrategyProtocol
  readonly evaluation: CandidateDevelopmentCommandEvaluation
  readonly reviewedTerminalSummary: CandidateDevelopmentReviewedTerminalSummary
  readonly contentHash: string
}

export interface CandidateDevelopmentEvidenceExpectation {
  readonly bindings: CandidateDevelopmentEvidenceBindings
  readonly evidenceContentHash: string
  readonly independentlyReproducedEvaluationHash: string
  readonly independentlyReproducedDecisionOutputHash: string
}

export interface CandidateDevelopmentIndependentReproduction {
  readonly schemaVersion: 'bayn.candidate-development-independent-reproduction.v1'
  readonly sourceRevision: string
  readonly modulePath: string
  readonly moduleBlobOid: string
  readonly moduleSha256: string
  readonly evaluation: CandidateDevelopmentCommandEvaluation
  readonly evaluationHash: string
  readonly decisionOutputHash: string
}

export interface CandidateDevelopmentEvidenceDecodeIssue {
  readonly _tag: 'CandidateDevelopmentEvidenceDecodeFailed'
  readonly cause: unknown
}

export type CandidateDevelopmentEvidenceIssue =
  | { readonly _tag: 'CandidateDevelopmentEvidenceMissing' }
  | CandidateDevelopmentEvidenceDecodeIssue
  | { readonly _tag: 'CandidateDevelopmentEvidenceHashFailed'; readonly cause: CanonicalHashFailure }
  | {
      readonly _tag: 'CandidateDevelopmentEvidenceContentHashMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentEvidenceBindingMismatch'
      readonly field: string
      readonly expected: unknown
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentEvidencePreflightInvalid'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentEvidenceEvaluationInvalid'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentEvidenceComparisonInvalid'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentEvidenceEconomicInvalid'
      readonly field: string
      readonly expected: unknown
      readonly observed: unknown
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentEvidenceDoubledCostInvalid'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentEvidenceReproductionMismatch'
      readonly field:
        | 'sourceRevision'
        | 'modulePath'
        | 'moduleBlobOid'
        | 'moduleSha256'
        | 'evaluation'
        | 'decisionOutput'
      readonly expected: string
      readonly observed: string
    }
  | { readonly _tag: 'CandidateDevelopmentEvidenceReproductionMissing' }
  | {
      readonly _tag: 'CandidateDevelopmentEvidenceReproductionFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentEvidenceApprovalInvalid'
      readonly cause: unknown
    }

export type CandidateDevelopmentEligibilityDecision =
  | {
      readonly status: 'DEVELOPMENT_APPROVED'
      readonly evidenceContentHash: string
      readonly decision: CandidateDevelopmentDecision
      readonly nextCandidatePreregistration: CandidateDevelopmentNextPreregistration
    }
  | {
      readonly status: 'DEVELOPMENT_REJECTED'
      readonly evidenceContentHash: string
      readonly decision: CandidateDevelopmentDecision
      readonly nextCandidatePreregistration: null
    }
  | {
      readonly status: 'DEVELOPMENT_EVIDENCE_INVALID'
      readonly issues: readonly CandidateDevelopmentEvidenceIssue[]
      readonly nextCandidatePreregistration: null
    }

export type CandidateDevelopmentQualificationAuthorization<A> =
  | { readonly status: 'AUTHORIZED'; readonly value: A }
  | {
      readonly status: 'BLOCKED'
      readonly reason: Exclude<CandidateDevelopmentEligibilityDecision['status'], 'DEVELOPMENT_APPROVED'>
    }

export interface CandidateDevelopmentValidatedEvidence {
  readonly preflight: CandidateDevelopmentPreflightPass
  readonly evaluation: CandidateDevelopmentCommandEvaluation
  readonly decision: CandidateDevelopmentDecision
  readonly development: CandidateDevelopmentReport
}
