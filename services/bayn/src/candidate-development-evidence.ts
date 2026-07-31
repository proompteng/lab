import { pipe, Result, Schema } from 'effect'

import {
  candidateDevelopmentCalendarContract,
  candidateDevelopmentComparisonSemantics,
  preflightCandidateDevelopment,
  validateCandidateDevelopmentComparisonSemanticsEvidence,
  validateCandidateDevelopmentComparisonSeriesBinding,
  validateCandidateDevelopmentDoubledCostCausalPath,
  type CandidateDevelopmentDoubledCostRun,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentPreflightPass,
  type CandidateDevelopmentReport,
} from './candidate-development'
import {
  deriveCandidateDevelopmentDecision,
  type CandidateDevelopmentDecision,
  type CandidateDevelopmentNextPreregistration,
} from './candidate-development-decision'
import {
  buildCandidateDevelopmentCommandReport,
  CandidateDevelopmentEvaluationSchema,
  CandidateDevelopmentPreflightInputSchema,
  CandidateDevelopmentSourceManifestSchema,
  CandidateDevelopmentStrategyProtocolSchema,
  validateCandidateDevelopmentCommandEvaluation,
  type CandidateDevelopmentCommandEvaluation,
  type CandidateDevelopmentStrategyProtocol,
  type CandidateDevelopmentVerifiedSource,
} from './candidate-development-command'
import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
import { prepareQualificationSeries } from './qualification-statistics'
import {
  GitSourceRevisionSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'
import { buildVerdict, calculateExactPerformanceMetrics } from './simulation/metrics'
import type { DailyPerformancePoint, EvaluationResult, PerformanceMetrics } from './types'

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

const CandidateDevelopmentMarketDataBindingSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v1'),
  snapshotId: Sha256Schema,
  finalizedSnapshotContentHash: Sha256Schema,
  inputManifestHash: Sha256Schema,
  boundedContentHash: Sha256Schema,
})

const CandidateDevelopmentEvidenceBindingsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-evidence-bindings.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  preregistration: Schema.Struct({
    sourceRevision: GitSourceRevisionSchema,
    path: StrictNonEmptyStringSchema,
    blobOid: GitSourceRevisionSchema,
  }),
  reviewedSourceRevision: GitSourceRevisionSchema,
  mergedSourceRevision: GitSourceRevisionSchema,
  module: Schema.Struct({
    path: StrictNonEmptyStringSchema,
    blobOid: GitSourceRevisionSchema,
    sha256: Sha256Schema,
  }),
  sourceManifest: Schema.Struct({
    path: StrictNonEmptyStringSchema,
    blobOid: GitSourceRevisionSchema,
    sha256: Sha256Schema,
  }),
  strategyProtocolHash: Sha256Schema,
  candidateDevelopmentProtocolHash: Sha256Schema,
  marketData: CandidateDevelopmentMarketDataBindingSchema,
  calendar: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-calendar.v1'),
    calendarVersion: Schema.Literal('alpaca-us-equity-calendar-v1'),
    start: Schema.Literal('2016-01-04'),
    end: Schema.Literal('2022-12-30'),
    sessionCount: Schema.Literal(1_762),
    sessionsHash: Schema.Literal('a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1'),
  }),
})

const CandidateDevelopmentVerifiedSourceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-verified-source.v1'),
  sourceRevision: GitSourceRevisionSchema,
  modulePath: StrictNonEmptyStringSchema,
  moduleBlobOid: GitSourceRevisionSchema,
  moduleSha256: Sha256Schema,
  sourceManifestPath: StrictNonEmptyStringSchema,
  sourceManifestBlobOid: GitSourceRevisionSchema,
  sourceManifestSha256: Sha256Schema,
  sourceManifest: CandidateDevelopmentSourceManifestSchema,
  baselineRunId: Sha256Schema,
  stressedRunId: Sha256Schema,
})

const CandidateDevelopmentReviewedTerminalSummarySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-reviewed-terminal-summary.v1'),
  source: Schema.Literal('reviewed-development-only-evaluation'),
  strategyAnnualizedReturn: Schema.Finite,
  buyAndHoldAnnualizedReturn: Schema.Finite,
  annualizedReturnDifferenceLowerBound: Schema.Finite,
  sharpeDifferenceLowerBound: Schema.Finite,
  verdict: Schema.Literals(['PASS', 'FAIL_CLOSED']),
  researchContext: Schema.Tuple([
    Schema.Literal('https://doi.org/10.1111/1468-0262.00152'),
    Schema.Literal('https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253'),
  ]),
})

export const CandidateDevelopmentImmutableEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-immutable-evidence.v2'),
  recordedAt: UtcInstantSchema,
  bindings: CandidateDevelopmentEvidenceBindingsSchema,
  input: CandidateDevelopmentPreflightInputSchema,
  verifiedSource: CandidateDevelopmentVerifiedSourceSchema,
  strategyProtocol: CandidateDevelopmentStrategyProtocolSchema,
  evaluation: CandidateDevelopmentEvaluationSchema,
  reviewedTerminalSummary: CandidateDevelopmentReviewedTerminalSummarySchema,
  contentHash: Sha256Schema,
})

export interface CandidateDevelopmentEvidenceDecodeIssue {
  readonly _tag: 'CandidateDevelopmentEvidenceDecodeFailed'
  readonly cause: unknown
}

const decodeCandidateDevelopmentImmutableEvidenceBoundary = Schema.decodeUnknownResult(
  CandidateDevelopmentImmutableEvidenceSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentImmutableEvidence = (
  value: unknown,
): Result.Result<CandidateDevelopmentImmutableEvidence, CandidateDevelopmentEvidenceDecodeIssue> => {
  const decoded = decodeCandidateDevelopmentImmutableEvidenceBoundary(value)
  if (Result.isFailure(decoded)) {
    return Result.fail({ _tag: 'CandidateDevelopmentEvidenceDecodeFailed', cause: decoded.failure })
  }
  const evaluation = validateCandidateDevelopmentCommandEvaluation(decoded.success.evaluation)
  if (Result.isFailure(evaluation)) {
    return Result.fail({ _tag: 'CandidateDevelopmentEvidenceDecodeFailed', cause: evaluation.failure })
  }
  return Result.succeed({ ...decoded.success, evaluation: evaluation.success } as CandidateDevelopmentImmutableEvidence)
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

export const withCandidateDevelopmentQualificationAuthorization = <A>(
  decision: CandidateDevelopmentEligibilityDecision,
  loadQualificationInput: (preregistration: CandidateDevelopmentNextPreregistration) => A,
): CandidateDevelopmentQualificationAuthorization<A> =>
  decision.status === 'DEVELOPMENT_APPROVED'
    ? { status: 'AUTHORIZED', value: loadQualificationInput(decision.nextCandidatePreregistration) }
    : { status: 'BLOCKED', reason: decision.status }

const evidenceMaterial = (
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

export const buildCandidateDevelopmentIndependentReproduction = (
  verifiedSource: CandidateDevelopmentVerifiedSource,
  evaluation: CandidateDevelopmentCommandEvaluation,
): Result.Result<CandidateDevelopmentIndependentReproduction, CandidateDevelopmentEvidenceIssue> =>
  pipe(
    Result.all({
      evaluationHash: pipe(
        canonicalHashV1Result(evaluation),
        Result.mapError(
          (cause): CandidateDevelopmentEvidenceIssue => ({
            _tag: 'CandidateDevelopmentEvidenceHashFailed',
            cause,
          }),
        ),
      ),
      decisionOutputHash: pipe(
        canonicalHashV1Result(candidateDevelopmentDecisionOutputMaterial(evaluation)),
        Result.mapError(
          (cause): CandidateDevelopmentEvidenceIssue => ({
            _tag: 'CandidateDevelopmentEvidenceHashFailed',
            cause,
          }),
        ),
      ),
    }),
    Result.map(({ decisionOutputHash, evaluationHash }) => ({
      schemaVersion: 'bayn.candidate-development-independent-reproduction.v1' as const,
      sourceRevision: verifiedSource.sourceRevision,
      modulePath: verifiedSource.modulePath,
      moduleBlobOid: verifiedSource.moduleBlobOid,
      moduleSha256: verifiedSource.moduleSha256,
      evaluation,
      evaluationHash,
      decisionOutputHash,
    })),
  )

export const validateCandidateDevelopmentIndependentReproduction = (
  evidence: CandidateDevelopmentImmutableEvidence,
  expectation: CandidateDevelopmentEvidenceExpectation,
  reproduction: CandidateDevelopmentIndependentReproduction,
): readonly CandidateDevelopmentEvidenceIssue[] => {
  const issues: CandidateDevelopmentEvidenceIssue[] = []
  const decoded = validateCandidateDevelopmentCommandEvaluation(reproduction.evaluation)
  if (Result.isFailure(decoded)) {
    return [{ _tag: 'CandidateDevelopmentEvidenceReproductionFailed', cause: decoded.failure }]
  }

  const bindings = [
    ['sourceRevision', evidence.verifiedSource.sourceRevision, reproduction.sourceRevision],
    ['modulePath', evidence.verifiedSource.modulePath, reproduction.modulePath],
    ['moduleBlobOid', evidence.verifiedSource.moduleBlobOid, reproduction.moduleBlobOid],
    ['moduleSha256', evidence.verifiedSource.moduleSha256, reproduction.moduleSha256],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) {
      issues.push({
        _tag: 'CandidateDevelopmentEvidenceReproductionMismatch',
        field,
        expected,
        observed,
      })
    }
  }

  const reproducedEvaluationHash = canonicalHashV1Result(decoded.success)
  if (Result.isFailure(reproducedEvaluationHash)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: reproducedEvaluationHash.failure })
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
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: reproducedDecisionOutputHash.failure })
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

const sameCanonical = (left: unknown, right: unknown): Result.Result<boolean, CanonicalHashFailure> => {
  const leftHash = canonicalHashV1Result(left)
  if (Result.isFailure(leftHash)) return Result.fail(leftHash.failure)
  const rightHash = canonicalHashV1Result(right)
  return Result.isFailure(rightHash)
    ? Result.fail(rightHash.failure)
    : Result.succeed(leftHash.success === rightHash.success)
}

const collectCanonicalBinding = (
  issues: CandidateDevelopmentEvidenceIssue[],
  field: string,
  expected: unknown,
  observed: unknown,
): void => {
  const equal = sameCanonical(expected, observed)
  if (Result.isFailure(equal)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: equal.failure })
  } else if (!equal.success) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceBindingMismatch', field, expected, observed })
  }
}

const collectEvidenceBindings = (
  issues: CandidateDevelopmentEvidenceIssue[],
  expected: CandidateDevelopmentEvidenceBindings,
  observed: CandidateDevelopmentEvidenceBindings,
): void => {
  const fields: readonly (readonly [string, unknown, unknown])[] = [
    ['schemaVersion', expected.schemaVersion, observed.schemaVersion],
    ['candidateOrdinal', expected.candidateOrdinal, observed.candidateOrdinal],
    ['priorTrialCount', expected.priorTrialCount, observed.priorTrialCount],
    ['preregistration', expected.preregistration, observed.preregistration],
    ['reviewedSourceRevision', expected.reviewedSourceRevision, observed.reviewedSourceRevision],
    ['mergedSourceRevision', expected.mergedSourceRevision, observed.mergedSourceRevision],
    ['module', expected.module, observed.module],
    ['sourceManifest', expected.sourceManifest, observed.sourceManifest],
    ['strategyProtocolHash', expected.strategyProtocolHash, observed.strategyProtocolHash],
    [
      'candidateDevelopmentProtocolHash',
      expected.candidateDevelopmentProtocolHash,
      observed.candidateDevelopmentProtocolHash,
    ],
    ['marketData', expected.marketData, observed.marketData],
    ['calendar', expected.calendar, observed.calendar],
  ]
  for (const [field, expectedValue, observedValue] of fields) {
    collectCanonicalBinding(issues, field, expectedValue, observedValue)
  }
}

const expectedPreregistrationFromBindings = (
  bindings: CandidateDevelopmentEvidenceBindings,
): CandidateDevelopmentNextPreregistration => ({
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
  candidateOrdinal: bindings.candidateOrdinal,
  priorTrialCount: bindings.priorTrialCount,
  strategyProtocolHash: bindings.strategyProtocolHash,
  modulePath: bindings.module.path,
  moduleSha256: bindings.module.sha256,
  marketData: bindings.marketData,
  preregistration: bindings.preregistration,
})

const fullMetricFields = [
  'observations',
  'totalReturn',
  'annualizedReturn',
  'annualizedVolatility',
  'sharpe',
  'maximumDrawdown',
  'annualTurnover',
  'totalFeesMicros',
  'totalSpreadCostMicros',
  'totalSlippageCostMicros',
  'totalCashYieldMicros',
  'endingEquityMicros',
] as const satisfies readonly (keyof PerformanceMetrics)[]

type ExactPerformancePoint = Pick<
  DailyPerformancePoint,
  | 'equityMicros'
  | 'cumulativeTurnoverMicros'
  | 'cumulativeFeesMicros'
  | 'cumulativeSpreadCostMicros'
  | 'cumulativeSlippageCostMicros'
  | 'cumulativeCashYieldMicros'
>

const exactMetricsFromPoints = (
  field: string,
  points: readonly ExactPerformancePoint[],
  initialCapitalMicros: string,
): Result.Result<PerformanceMetrics, CandidateDevelopmentEvidenceIssue> => {
  const last = points.at(-1)
  const values = [
    initialCapitalMicros,
    ...(last === undefined
      ? []
      : [
          last.cumulativeTurnoverMicros,
          last.cumulativeFeesMicros,
          last.cumulativeSpreadCostMicros,
          last.cumulativeSlippageCostMicros,
          last.cumulativeCashYieldMicros,
        ]),
    ...points.map((point) => point.equityMicros),
  ]
  const invalid = values.find((value) => !/^\d+$/.test(value))
  if (last === undefined || invalid !== undefined) {
    return Result.fail({
      _tag: 'CandidateDevelopmentEvidenceEconomicInvalid',
      field,
      expected: 'nonempty performance series with unsigned integer micros',
      observed: invalid ?? null,
    })
  }
  return pipe(
    calculateExactPerformanceMetrics(
      points.map((point) => BigInt(point.equityMicros)),
      BigInt(last.cumulativeTurnoverMicros),
      BigInt(last.cumulativeFeesMicros),
      BigInt(last.cumulativeSpreadCostMicros),
      BigInt(last.cumulativeSlippageCostMicros),
      BigInt(last.cumulativeCashYieldMicros),
      BigInt(initialCapitalMicros),
    ),
    Result.mapError(
      (cause): CandidateDevelopmentEvidenceIssue => ({
        _tag: 'CandidateDevelopmentEvidenceEconomicInvalid',
        field,
        expected: 'metrics reproducible from the bound equity and cumulative accounting series',
        observed: null,
        cause,
      }),
    ),
  )
}

const collectMetricBinding = (
  issues: CandidateDevelopmentEvidenceIssue[],
  field: string,
  expected: PerformanceMetrics,
  observed: PerformanceMetrics,
): void => {
  const expectedProjection = Object.fromEntries(fullMetricFields.map((key) => [key, expected[key]]))
  const observedProjection = Object.fromEntries(fullMetricFields.map((key) => [key, observed[key]]))
  const equal = sameCanonical(expectedProjection, observedProjection)
  if (Result.isFailure(equal)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: equal.failure })
  } else if (!equal.success) {
    issues.push({
      _tag: 'CandidateDevelopmentEvidenceEconomicInvalid',
      field,
      expected: expectedProjection,
      observed: observedProjection,
    })
  }
}

const terminalCash = (simulation: EvaluationResult['simulation']): boolean =>
  simulation.dailyMarks.at(-1)?.positions.every((position) => position.quantityMicros === '0') ?? false

const buildDevelopmentReport = (
  preflight: CandidateDevelopmentPreflightPass,
  evaluation: CandidateDevelopmentCommandEvaluation,
): CandidateDevelopmentReport => ({
  schemaVersion: candidateDevelopmentComparisonSemantics.evidence.reportSchemaVersion,
  protocolIdentity: preflight.protocolIdentity,
  comparisonSemantics: evaluation.comparisonSemantics,
  doubledCostContract: preflight.doubledCostContract,
  doubledCost: {
    baseline: {
      signalDecisions: evaluation.baseline.signalDecisions,
      simulation: evaluation.baseline.simulation,
    },
    stressed: evaluation.stressed,
  },
})

interface CandidateDevelopmentValidatedEvidence {
  readonly preflight: CandidateDevelopmentPreflightPass
  readonly evaluation: CandidateDevelopmentCommandEvaluation
  readonly decision: CandidateDevelopmentDecision
  readonly development: CandidateDevelopmentReport
}

const validateCompleteEvidence = (
  evidence: CandidateDevelopmentImmutableEvidence,
  issues: CandidateDevelopmentEvidenceIssue[],
): CandidateDevelopmentValidatedEvidence | null => {
  const strategyProtocolHash = canonicalHashV1Result(evidence.strategyProtocol)
  if (Result.isFailure(strategyProtocolHash)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: strategyProtocolHash.failure })
  } else if (strategyProtocolHash.success !== evidence.bindings.strategyProtocolHash) {
    issues.push({
      _tag: 'CandidateDevelopmentEvidenceBindingMismatch',
      field: 'strategyProtocol',
      expected: evidence.bindings.strategyProtocolHash,
      observed: strategyProtocolHash.success,
    })
  }

  const preflightResult = preflightCandidateDevelopment(evidence.input)
  if (Result.isFailure(preflightResult) || preflightResult.success.status !== 'PASS') {
    issues.push({
      _tag: 'CandidateDevelopmentEvidencePreflightInvalid',
      cause: Result.isFailure(preflightResult) ? preflightResult.failure : preflightResult.success,
    })
    return null
  }
  const preflight = preflightResult.success
  collectCanonicalBinding(
    issues,
    'preflight.candidateDevelopmentProtocolHash',
    evidence.bindings.candidateDevelopmentProtocolHash,
    preflight.protocolIdentity.candidateDevelopmentProtocolHash,
  )
  collectCanonicalBinding(
    issues,
    'preflight.strategyProtocolHash',
    evidence.bindings.strategyProtocolHash,
    preflight.expectedStrategyProtocolHash,
  )

  const evaluationResult = validateCandidateDevelopmentCommandEvaluation(evidence.evaluation)
  if (Result.isFailure(evaluationResult)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceEvaluationInvalid', cause: evaluationResult.failure })
    return null
  }
  const evaluation = evaluationResult.success
  const sourceBindings: readonly (readonly [string, unknown, unknown])[] = [
    ['evaluation.baseline.codeRevision', evidence.verifiedSource.sourceRevision, evaluation.baseline.codeRevision],
    ['evaluation.baseline.runId', evidence.verifiedSource.baselineRunId, evaluation.baseline.runId],
    ['evaluation.accounting.runId', evidence.verifiedSource.baselineRunId, evaluation.accounting.runId],
    ['evaluation.accounting.stressedRunId', evidence.verifiedSource.stressedRunId, evaluation.accounting.stressedRunId],
    ['evaluation.baseline.protocolHash', evidence.bindings.strategyProtocolHash, evaluation.baseline.protocolHash],
    ['evaluation.marketData.snapshotId', evidence.bindings.marketData.snapshotId, evaluation.marketData.snapshotId],
    [
      'evaluation.marketData.contentHash',
      evidence.bindings.marketData.boundedContentHash,
      evaluation.marketData.contentHash,
    ],
    [
      'evaluation.baseline.inputManifest.hash',
      evidence.bindings.marketData.inputManifestHash,
      evaluation.baseline.inputManifest.hash,
    ],
    [
      'evaluation.baseline.inputManifest.finalizedSnapshot.contentHash',
      evidence.bindings.marketData.finalizedSnapshotContentHash,
      evaluation.baseline.inputManifest.finalizedSnapshot.contentHash,
    ],
  ]
  for (const [field, expected, observed] of sourceBindings) {
    collectCanonicalBinding(issues, field, expected, observed)
  }

  const series = prepareQualificationSeries(evaluation.baseline)
  if (Result.isFailure(series)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceComparisonInvalid', cause: series.failure })
    return null
  }
  const seriesBinding = validateCandidateDevelopmentComparisonSeriesBinding(
    preflight,
    evaluation.baseline,
    series.success,
  )
  if (Result.isFailure(seriesBinding)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceComparisonInvalid', cause: seriesBinding.failure })
    return null
  }
  const comparison = validateCandidateDevelopmentComparisonSemanticsEvidence(
    preflight,
    seriesBinding.success,
    evaluation.comparisonSemantics,
  )
  if (Result.isFailure(comparison)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceComparisonInvalid', cause: comparison.failure })
    return null
  }

  const initialCapitalMicros = evaluation.baseline.initialCapitalMicros
  const metrics = Result.all({
    strategy: exactMetricsFromPoints(
      'economic.strategy',
      evaluation.baseline.simulation.dailyMarks,
      initialCapitalMicros,
    ),
    buyAndHold: exactMetricsFromPoints(
      'economic.buyAndHold',
      evaluation.baseline.benchmarkSeries.buyAndHold,
      initialCapitalMicros,
    ),
    directVolTiming: exactMetricsFromPoints(
      'economic.directVolTiming',
      evaluation.baseline.benchmarkSeries.directVolTiming,
      initialCapitalMicros,
    ),
    doubleCostStrategy: exactMetricsFromPoints(
      'economic.doubleCostStrategy',
      evaluation.stressed.simulation.dailyMarks,
      initialCapitalMicros,
    ),
    recordedDoubleCostSeries: exactMetricsFromPoints(
      'economic.recordedDoubleCostSeries',
      evaluation.baseline.benchmarkSeries.doubleCostStrategy,
      initialCapitalMicros,
    ),
  })
  if (Result.isFailure(metrics)) {
    issues.push(metrics.failure)
    return null
  }
  collectMetricBinding(issues, 'economic.strategy', metrics.success.strategy, evaluation.baseline.strategy)
  collectMetricBinding(issues, 'economic.buyAndHold', metrics.success.buyAndHold, evaluation.baseline.buyAndHold)
  collectMetricBinding(
    issues,
    'economic.directVolTiming',
    metrics.success.directVolTiming,
    evaluation.baseline.directVolTiming,
  )
  collectMetricBinding(
    issues,
    'economic.doubleCostStrategy',
    metrics.success.doubleCostStrategy,
    evaluation.baseline.doubleCostStrategy,
  )
  collectMetricBinding(
    issues,
    'economic.doubleCostSeries',
    metrics.success.doubleCostStrategy,
    metrics.success.recordedDoubleCostSeries,
  )

  const expectedVerdict = buildVerdict(
    metrics.success.strategy,
    metrics.success.buyAndHold,
    metrics.success.directVolTiming,
    metrics.success.doubleCostStrategy,
    evidence.strategyProtocol,
  )
  collectCanonicalBinding(issues, 'economic.verdict', expectedVerdict, evaluation.baseline.verdict)

  const baselineRun: CandidateDevelopmentDoubledCostRun = {
    signalDecisions: evaluation.baseline.signalDecisions,
    simulation: evaluation.baseline.simulation,
  }
  const causalPath = validateCandidateDevelopmentDoubledCostCausalPath(baselineRun, evaluation.stressed)
  if (Result.isFailure(causalPath)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceDoubledCostInvalid', cause: causalPath.failure })
  }

  const baselineTerminalCash = terminalCash(evaluation.baseline.simulation)
  const stressedTerminalCash = terminalCash(evaluation.stressed.simulation)
  const decision = deriveCandidateDevelopmentDecision({
    comparison: comparison.success.analysis,
    doubledCostAnnualizedReturn: metrics.success.doubleCostStrategy.annualizedReturn,
    economicPass: expectedVerdict.gates.every((gate) => gate.passed),
    baselineTerminalCash,
    stressedTerminalCash,
  })

  const reviewedMetrics = [
    [
      'reviewedTerminalSummary.strategyAnnualizedReturn',
      Number(metrics.success.strategy.annualizedReturn.toFixed(5)),
      evidence.reviewedTerminalSummary.strategyAnnualizedReturn,
    ],
    [
      'reviewedTerminalSummary.buyAndHoldAnnualizedReturn',
      Number(metrics.success.buyAndHold.annualizedReturn.toFixed(6)),
      evidence.reviewedTerminalSummary.buyAndHoldAnnualizedReturn,
    ],
  ] as const
  for (const [field, expected, observed] of reviewedMetrics) {
    if (!Object.is(expected, observed)) {
      issues.push({ _tag: 'CandidateDevelopmentEvidenceEconomicInvalid', field, expected, observed })
    }
  }
  for (const [field, value] of [
    [
      'reviewedTerminalSummary.annualizedReturnDifferenceLowerBound',
      evidence.reviewedTerminalSummary.annualizedReturnDifferenceLowerBound,
    ],
    ['reviewedTerminalSummary.sharpeDifferenceLowerBound', evidence.reviewedTerminalSummary.sharpeDifferenceLowerBound],
  ] as const) {
    if (!Number.isFinite(value)) {
      issues.push({
        _tag: 'CandidateDevelopmentEvidenceEconomicInvalid',
        field,
        expected: 'finite reviewed development statistic',
        observed: value,
      })
    }
  }

  return {
    preflight,
    evaluation,
    decision,
    development: buildDevelopmentReport(preflight, evaluation),
  }
}

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
  const computedHash = canonicalHashV1Result(evidenceMaterial(evidence))
  if (Result.isFailure(computedHash)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: computedHash.failure })
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
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: evaluationHash.failure })
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
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: decisionOutputHash.failure })
  } else if (decisionOutputHash.success !== expectation.independentlyReproducedDecisionOutputHash) {
    issues.push({
      _tag: 'CandidateDevelopmentEvidenceReproductionMismatch',
      field: 'decisionOutput',
      expected: expectation.independentlyReproducedDecisionOutputHash,
      observed: decisionOutputHash.success,
    })
  }
  collectEvidenceBindings(issues, expectation.bindings, evidence.bindings)
  collectCanonicalBinding(
    issues,
    'qualificationPreregistration',
    expectedPreregistrationFromBindings(evidence.bindings),
    preregistration,
  )
  collectCanonicalBinding(
    issues,
    'input.candidateOrdinal',
    evidence.bindings.candidateOrdinal,
    evidence.input.candidateOrdinal,
  )
  collectCanonicalBinding(
    issues,
    'input.priorTrialCount',
    evidence.bindings.priorTrialCount,
    evidence.input.priorTrialCount,
  )
  collectCanonicalBinding(
    issues,
    'verifiedSource.sourceRevision',
    evidence.bindings.reviewedSourceRevision,
    evidence.verifiedSource.sourceRevision,
  )
  collectCanonicalBinding(
    issues,
    'verifiedSource.modulePath',
    evidence.bindings.module.path,
    evidence.verifiedSource.modulePath,
  )
  collectCanonicalBinding(
    issues,
    'verifiedSource.moduleBlobOid',
    evidence.bindings.module.blobOid,
    evidence.verifiedSource.moduleBlobOid,
  )
  collectCanonicalBinding(
    issues,
    'verifiedSource.moduleSha256',
    evidence.bindings.module.sha256,
    evidence.verifiedSource.moduleSha256,
  )
  collectCanonicalBinding(
    issues,
    'verifiedSource.sourceManifestPath',
    evidence.bindings.sourceManifest.path,
    evidence.verifiedSource.sourceManifestPath,
  )
  collectCanonicalBinding(
    issues,
    'verifiedSource.sourceManifestBlobOid',
    evidence.bindings.sourceManifest.blobOid,
    evidence.verifiedSource.sourceManifestBlobOid,
  )
  collectCanonicalBinding(
    issues,
    'verifiedSource.sourceManifestSha256',
    evidence.bindings.sourceManifest.sha256,
    evidence.verifiedSource.sourceManifestSha256,
  )

  const validated = validateCompleteEvidence(evidence, issues)
  if (issues.length > 0 || validated === null) {
    return { status: 'DEVELOPMENT_EVIDENCE_INVALID', issues, nextCandidatePreregistration: null }
  }
  if (validated.decision.status === 'HOLD_REJECT') {
    return {
      status: 'DEVELOPMENT_REJECTED',
      evidenceContentHash: evidence.contentHash,
      decision: validated.decision,
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
    validated.development,
    validated.evaluation,
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
  collectCanonicalBinding(issues, 'approval.decision', validated.decision, approval.success.decision)
  if (issues.length > 0) {
    return { status: 'DEVELOPMENT_EVIDENCE_INVALID', issues, nextCandidatePreregistration: null }
  }
  return {
    status: 'DEVELOPMENT_APPROVED',
    evidenceContentHash: evidence.contentHash,
    decision: validated.decision,
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
