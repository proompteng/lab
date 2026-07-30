import { Effect, pipe, Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
import {
  analyzeSelectedBenchmarkComparisonInput,
  defaultQualificationStatisticsPolicy,
  prepareQualificationSeries,
  qualificationSelectedBenchmarkRule,
  type QualificationSelectedBenchmarkComparisonAnalysis,
  type QualificationSeries,
  type QualificationStatisticsFailure,
  type QualificationStatisticsPolicy,
} from './qualification-statistics'
import type { IsoDate } from './schemas'
import type { EvaluationResult, SignalDecision, SimulatedOrder, SimulationTrace } from './types'

export const candidateDevelopmentCalendarContract = {
  schemaVersion: 'bayn.candidate-development-calendar.v1',
  calendarVersion: 'alpaca-us-equity-calendar-v1',
  start: '2016-01-04',
  end: '2022-12-30',
  sessionCount: 1_762,
  sessionsHash: 'a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1',
} as const

/**
 * Development model selection uses multiple chronological rolling origins with expanding training data, as described
 * by Tashman (2000, doi:10.1016/S0169-2070(00)00065-0). The 197-session test length is not a weakened terminal gate:
 * it is the largest equal test block that preserves 504 training sessions and five non-overlapping tests after a
 * 252-session causal lookback and next-session execution inside the frozen 1,762-session development calendar.
 * Latest-contiguous selection maximizes recency while deriving every boundary only from the frozen calendar and
 * preregistered geometry, never from realized returns.
 * Terminal qualification continues to use defaultQualificationStatisticsPolicy unchanged. Its paired complete-block
 * bootstrap also remains unchanged and samples only observed, non-wrapping rebalance blocks, following the dependent
 * block-resampling principle of Künsch (1989, doi:10.1214/aos/1176347265).
 */
export const candidateDevelopmentWalkForwardProtocol = {
  method: 'expanding-origin',
  foldSelection: 'latest-contiguous',
  minimumTrainingSessions: 504,
  testSessions: 197,
  requiredFolds: 5,
  maximumFeatureLookbackSessions: 252,
  executionLagSessions: 1,
} as const

export const candidateDevelopmentAttemptHorizon = {
  schemaVersion: 'bayn.candidate-development-attempt-horizon.v1',
  maximumCandidateOrdinal: 25,
  ordinalBinding: 'candidate-ordinal-equals-prior-trial-count-plus-one',
} as const

/**
 * Doubled-cost development evidence is a second causal simulator run at exactly 2x modeled execution costs. The run is
 * admissible only when the complete signal decisions and ordered requested/filled quantity path exactly match the 1x
 * baseline. Any affordability or equity feedback that changes that path is an invalid protocol deviation rather than
 * an alternative stressed result. Cash, fill prices, fees, and marked equity remain free to change causally.
 */
export const candidateDevelopmentDoubledCostContract = {
  schemaVersion: 'bayn.candidate-development-doubled-cost.v1',
  method: 'causal-rerun-with-invariant-signal-and-quantity-path',
  baselineCostMultiplierMicros: '1000000',
  stressedCostMultiplierMicros: '2000000',
  divergenceDisposition: 'INVALID_PROTOCOL_DEVIATION',
  invariants: ['signal-decisions', 'ordered-order-quantity-path'],
} as const

export const candidateDevelopmentBootstrapSamples = 10_000

export const candidateDevelopmentStatisticsPolicy = {
  ...defaultQualificationStatisticsPolicy,
  confidence: { ...defaultQualificationStatisticsPolicy.confidence },
  bootstrap: {
    ...defaultQualificationStatisticsPolicy.bootstrap,
    samples: candidateDevelopmentBootstrapSamples,
  },
  power: { ...defaultQualificationStatisticsPolicy.power },
  walkForward: {
    ...defaultQualificationStatisticsPolicy.walkForward,
    testSessions: candidateDevelopmentWalkForwardProtocol.testSessions,
    minimumFolds: candidateDevelopmentWalkForwardProtocol.requiredFolds,
  },
  cashReturn: { ...defaultQualificationStatisticsPolicy.cashReturn },
} as const satisfies QualificationStatisticsPolicy

export const candidateDevelopmentComparisonSemantics = {
  schemaVersion: 'bayn.candidate-development-comparison-semantics.v1',
  selectedBenchmarkRule: qualificationSelectedBenchmarkRule,
  evidence: {
    schemaVersion: 'bayn.candidate-development-comparison-semantics-evidence.v2',
    reportSchemaVersion: 'bayn.candidate-development-report.v1',
    analysisSchemaVersion: 'bayn.selected-benchmark-comparison-analysis.v1',
    source: 'baseline-evaluation-result',
    seriesProjection: 'prepare-qualification-series',
    windowBinding: 'exact-selected-preflight-sessions',
    analysis: 'recomputed-selected-benchmark-comparison',
    validation: 'exact-canonical-match',
  },
  gates: {
    power: {
      name: 'power',
      metric: 'complete-rebalance-block-and-session-sufficiency',
      baseline: 'not-applicable',
      reason: 'sampling-sufficiency',
    },
    bootstrapTailResolution: {
      name: 'bootstrap_tail_resolution',
      metric: 'bootstrap-lower-tail-sample-count',
      baseline: 'not-applicable',
      reason: 'sampling-sufficiency',
    },
    annualizedExcessReturnLowerBound: {
      name: 'annualized_excess_return_lower_bound',
      metric: 'annualized-return-difference',
      baseline: 'selected-benchmark',
    },
    sharpeDifferenceLowerBound: {
      name: 'sharpe_difference_lower_bound',
      metric: 'cash-adjusted-annualized-sharpe-difference',
      baseline: 'selected-benchmark',
    },
    walkForwardFolds: {
      name: 'walk_forward_folds',
      metric: 'walk-forward-fold-count',
      baseline: 'not-applicable',
      reason: 'geometry',
    },
    walkForwardPositiveFraction: {
      name: 'walk_forward_positive_fraction',
      metric: 'walk-forward-compounded-return-difference',
      baseline: 'selected-benchmark',
    },
    walkForwardDrawdown: {
      name: 'walk_forward_drawdown',
      metric: 'candidate-walk-forward-maximum-drawdown',
      baseline: 'candidate',
    },
  },
} as const

export const candidateDevelopmentProtocol = {
  schemaVersion: 'bayn.candidate-development-protocol.v3',
  calendar: candidateDevelopmentCalendarContract,
  walkForward: candidateDevelopmentWalkForwardProtocol,
  attemptHorizon: candidateDevelopmentAttemptHorizon,
  doubledCost: candidateDevelopmentDoubledCostContract,
  statisticsPolicy: candidateDevelopmentStatisticsPolicy,
  comparisonSemantics: candidateDevelopmentComparisonSemantics,
} as const

export interface CandidateDevelopmentProtocolIdentity {
  readonly schemaVersion: 'bayn.candidate-development-protocol-identity.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly featureLookbackSessions: number
  readonly protocolHash: string
}

export const identifyCandidateDevelopmentProtocol = (
  attempt: CandidateDevelopmentBootstrapTailCapacity,
  featureLookbackSessions: number,
): Result.Result<CandidateDevelopmentProtocolIdentity, CanonicalHashFailure> =>
  pipe(
    canonicalHashV1Result({
      schemaVersion: 'bayn.candidate-development-protocol-binding.v1',
      protocol: candidateDevelopmentProtocol,
      attempt,
      featureLookbackSessions,
    }),
    Result.map((protocolHash) => ({
      schemaVersion: 'bayn.candidate-development-protocol-identity.v1' as const,
      candidateOrdinal: attempt.candidateOrdinal,
      priorTrialCount: attempt.priorTrialCount,
      featureLookbackSessions,
      protocolHash,
    })),
  )

export interface CandidateDevelopmentBootstrapTailCapacity {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly bootstrapSamples: number
  readonly adjustedOneSidedAlpha: number
  readonly tailSampleCount: number
  readonly minimumTailSamples: number
  readonly maximumCandidateOrdinal: number
}

export type CandidateDevelopmentAttemptIssue =
  | {
      readonly _tag: 'CandidateDevelopmentCandidateOrdinalInvalid'
      readonly candidateOrdinal: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentPriorTrialCountInvalid'
      readonly priorTrialCount: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentAttemptLineageMismatch'
      readonly candidateOrdinal: number
      readonly priorTrialCount: number
      readonly expectedCandidateOrdinal: number
    }
  | ({
      readonly _tag: 'CandidateDevelopmentBootstrapTailInfeasible'
    } & CandidateDevelopmentBootstrapTailCapacity)

export const bindCandidateDevelopmentAttempt = (
  candidateOrdinal: number,
  priorTrialCount: number,
): Result.Result<CandidateDevelopmentBootstrapTailCapacity, CandidateDevelopmentAttemptIssue> => {
  if (!Number.isSafeInteger(candidateOrdinal) || candidateOrdinal <= 0) {
    return Result.fail({ _tag: 'CandidateDevelopmentCandidateOrdinalInvalid', candidateOrdinal })
  }
  if (!Number.isSafeInteger(priorTrialCount) || priorTrialCount < 0) {
    return Result.fail({ _tag: 'CandidateDevelopmentPriorTrialCountInvalid', priorTrialCount })
  }
  const expectedCandidateOrdinal = priorTrialCount + 1
  if (candidateOrdinal !== expectedCandidateOrdinal) {
    return Result.fail({
      _tag: 'CandidateDevelopmentAttemptLineageMismatch',
      candidateOrdinal,
      priorTrialCount,
      expectedCandidateOrdinal,
    })
  }

  const adjustedOneSidedAlpha = candidateDevelopmentStatisticsPolicy.confidence.familyOneSidedAlpha / candidateOrdinal
  const tailSampleCount = Math.floor(candidateDevelopmentStatisticsPolicy.bootstrap.samples * adjustedOneSidedAlpha)
  const capacity = {
    candidateOrdinal,
    priorTrialCount,
    bootstrapSamples: candidateDevelopmentStatisticsPolicy.bootstrap.samples,
    adjustedOneSidedAlpha,
    tailSampleCount,
    minimumTailSamples: candidateDevelopmentStatisticsPolicy.confidence.minimumTailSamples,
    maximumCandidateOrdinal: candidateDevelopmentAttemptHorizon.maximumCandidateOrdinal,
  }
  return candidateOrdinal <= candidateDevelopmentAttemptHorizon.maximumCandidateOrdinal &&
    tailSampleCount >= candidateDevelopmentStatisticsPolicy.confidence.minimumTailSamples
    ? Result.succeed(capacity)
    : Result.fail({ _tag: 'CandidateDevelopmentBootstrapTailInfeasible', ...capacity })
}

type CandidateDevelopmentOrderQuantityPathEntry = Pick<
  SimulatedOrder,
  | 'decisionId'
  | 'sessionDate'
  | 'symbol'
  | 'side'
  | 'requestedQuantityMicros'
  | 'filledQuantityMicros'
  | 'status'
  | 'rejectionReason'
  | 'unfilledRemainder'
>

export interface CandidateDevelopmentDoubledCostRun {
  readonly signalDecisions: readonly SignalDecision[]
  readonly simulation: SimulationTrace
}

export interface CandidateDevelopmentDoubledCostPass {
  readonly schemaVersion: 'bayn.candidate-development-doubled-cost-check.v1'
  readonly status: 'PASS'
  readonly signalDecisionsHash: string
  readonly orderQuantityPathHash: string
  readonly executionModelHash: string
}

export type CandidateDevelopmentDoubledCostIssue =
  | {
      readonly _tag: 'CandidateDevelopmentDoubledCostMultiplierMismatch'
      readonly run: 'baseline' | 'stressed'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentDoubledCostHashFailed'
      readonly material:
        | 'baseline-signals'
        | 'stressed-signals'
        | 'baseline-orders'
        | 'stressed-orders'
        | 'baseline-execution-model'
        | 'stressed-execution-model'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation'
      readonly disposition: 'INVALID_PROTOCOL_DEVIATION'
      readonly reason: 'EXECUTION_MODEL_CHANGED' | 'SIGNAL_DECISIONS_CHANGED' | 'ORDER_QUANTITY_PATH_CHANGED'
      readonly baselineHash: string
      readonly stressedHash: string
    }

type CandidateDevelopmentDoubledCostHashMaterial = Extract<
  CandidateDevelopmentDoubledCostIssue,
  { readonly _tag: 'CandidateDevelopmentDoubledCostHashFailed' }
>['material']

const orderQuantityPath = (orders: readonly SimulatedOrder[]): readonly CandidateDevelopmentOrderQuantityPathEntry[] =>
  orders.map(
    ({
      decisionId,
      sessionDate,
      symbol,
      side,
      requestedQuantityMicros,
      filledQuantityMicros,
      status,
      rejectionReason,
      unfilledRemainder,
    }) => ({
      decisionId,
      sessionDate,
      symbol,
      side,
      requestedQuantityMicros,
      filledQuantityMicros,
      status,
      rejectionReason,
      unfilledRemainder,
    }),
  )

const doubledCostHash = (
  material: CandidateDevelopmentDoubledCostHashMaterial,
  value: unknown,
): Result.Result<string, CandidateDevelopmentDoubledCostIssue> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError((cause) => ({
      _tag: 'CandidateDevelopmentDoubledCostHashFailed' as const,
      material,
      cause,
    })),
  )

const invariantHash = (
  reason: Extract<
    CandidateDevelopmentDoubledCostIssue,
    { readonly _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation' }
  >['reason'],
  baselineHash: string,
  stressedHash: string,
): Result.Result<string, CandidateDevelopmentDoubledCostIssue> =>
  baselineHash === stressedHash
    ? Result.succeed(baselineHash)
    : Result.fail({
        _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation',
        disposition: candidateDevelopmentDoubledCostContract.divergenceDisposition,
        reason,
        baselineHash,
        stressedHash,
      })

export const validateCandidateDevelopmentDoubledCostCausalPath = (
  baseline: CandidateDevelopmentDoubledCostRun,
  stressed: CandidateDevelopmentDoubledCostRun,
): Result.Result<CandidateDevelopmentDoubledCostPass, CandidateDevelopmentDoubledCostIssue> => {
  const multipliers = [
    ['baseline', candidateDevelopmentDoubledCostContract.baselineCostMultiplierMicros, baseline.simulation],
    ['stressed', candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros, stressed.simulation],
  ] as const
  for (const [run, expected, simulation] of multipliers) {
    if (simulation.costMultiplierMicros !== expected) {
      return Result.fail({
        _tag: 'CandidateDevelopmentDoubledCostMultiplierMismatch',
        run,
        expected,
        observed: simulation.costMultiplierMicros,
      })
    }
  }

  return pipe(
    Result.all({
      baselineSignals: doubledCostHash('baseline-signals', baseline.signalDecisions),
      stressedSignals: doubledCostHash('stressed-signals', stressed.signalDecisions),
      baselineOrders: doubledCostHash('baseline-orders', orderQuantityPath(baseline.simulation.orders)),
      stressedOrders: doubledCostHash('stressed-orders', orderQuantityPath(stressed.simulation.orders)),
      baselineExecutionModel: doubledCostHash('baseline-execution-model', baseline.simulation.executionModel),
      stressedExecutionModel: doubledCostHash('stressed-execution-model', stressed.simulation.executionModel),
    }),
    Result.flatMap(
      ({
        baselineExecutionModel,
        baselineOrders,
        baselineSignals,
        stressedExecutionModel,
        stressedOrders,
        stressedSignals,
      }) =>
        pipe(
          Result.all({
            executionModelHash: invariantHash(
              'EXECUTION_MODEL_CHANGED',
              baselineExecutionModel,
              stressedExecutionModel,
            ),
            signalDecisionsHash: invariantHash('SIGNAL_DECISIONS_CHANGED', baselineSignals, stressedSignals),
            orderQuantityPathHash: invariantHash('ORDER_QUANTITY_PATH_CHANGED', baselineOrders, stressedOrders),
          }),
          Result.map(({ executionModelHash, orderQuantityPathHash, signalDecisionsHash }) => ({
            schemaVersion: 'bayn.candidate-development-doubled-cost-check.v1' as const,
            status: 'PASS' as const,
            signalDecisionsHash,
            orderQuantityPathHash,
            executionModelHash,
          })),
        ),
    ),
  )
}

export interface CandidateDevelopmentWalkForwardGeometry {
  readonly minimumTrainingSessions: number
  readonly testSessions: number
  readonly requiredFolds: number
}

export interface CandidateDevelopmentExecutionBoundary {
  readonly signalIndex: number
  readonly signalDate: IsoDate
  readonly executionIndex: number
  readonly executionDate: IsoDate
}

export interface CandidateDevelopmentFoldBoundary {
  readonly ordinal: number
  readonly trainingStartIndex: number
  readonly trainingStart: IsoDate
  readonly trainingEndIndex: number
  readonly trainingEnd: IsoDate
  readonly trainingObservationCount: number
  readonly testStartIndex: number
  readonly testStart: IsoDate
  readonly testEndIndex: number
  readonly testEnd: IsoDate
  readonly testObservationCount: number
}

export interface CandidateDevelopmentGeometryPass {
  readonly status: 'PASS'
  readonly requiredObservations: number
  readonly availableObservations: number
  readonly availableFoldCount: number
  readonly requiredFoldCount: number
  readonly unusedEligibleObservations: number
  readonly selectedObservationStartIndex: number
  readonly selectedObservationStart: IsoDate
  readonly selectedObservationEndIndex: number
  readonly selectedObservationEnd: IsoDate
  readonly folds: readonly CandidateDevelopmentFoldBoundary[]
}

export interface CandidateDevelopmentGeometryFail {
  readonly status: 'FAIL'
  readonly reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS'
  readonly requiredObservations: number
  readonly availableObservations: number
  readonly availableFoldCount: number
  readonly requiredFoldCount: number
  readonly observationDeficit: number
}

export type CandidateDevelopmentGeometryDecision = CandidateDevelopmentGeometryPass | CandidateDevelopmentGeometryFail

export type CandidateDevelopmentGeometryIssue =
  | {
      readonly _tag: 'CandidateDevelopmentGeometryIntegerInvalid'
      readonly field:
        | 'availableSessions'
        | 'firstExecutionIndex'
        | 'minimumTrainingSessions'
        | 'testSessions'
        | 'requiredFolds'
      readonly value: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentGeometryPositiveIntegerRequired'
      readonly field: 'availableSessions' | 'minimumTrainingSessions' | 'testSessions' | 'requiredFolds'
      readonly value: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentExecutionOutsideCalendar'
      readonly firstExecutionIndex: number
      readonly availableSessions: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentGeometryOverflow'
      readonly operation: 'required-test-observations' | 'required-observations'
    }
  | {
      readonly _tag: 'CandidateDevelopmentFoldBoundaryMissing'
      readonly field: keyof CandidateDevelopmentFoldBoundary
      readonly index: number
    }

export type CandidateDevelopmentPreflightIssue =
  | CandidateDevelopmentGeometryIssue
  | CandidateDevelopmentAttemptIssue
  | {
      readonly _tag: 'CandidateDevelopmentCalendarDateInvalid'
      readonly index: number
      readonly value: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentCalendarNotStrictlyOrdered'
      readonly index: number
      readonly previous: IsoDate
      readonly current: IsoDate
    }
  | {
      readonly _tag: 'CandidateDevelopmentCalendarMismatch'
      readonly field: 'sessionCount' | 'start' | 'end' | 'sessionsHash'
      readonly expected: number | string
      readonly observed: number | string
    }
  | {
      readonly _tag: 'CandidateDevelopmentCalendarHashFailed'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentLookbackInvalid'
      readonly featureLookbackSessions: number
      readonly maximumFeatureLookbackSessions: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentSignalScheduleEmpty'
    }
  | {
      readonly _tag: 'CandidateDevelopmentSignalScheduleNotStrictlyOrdered'
      readonly index: number
      readonly previous: IsoDate
      readonly current: IsoDate
    }
  | {
      readonly _tag: 'CandidateDevelopmentSignalOutsideCalendar'
      readonly signalDate: IsoDate
    }
  | {
      readonly _tag: 'CandidateDevelopmentSignalScheduleMismatch'
      readonly index: number
      readonly expected: IsoDate | undefined
      readonly observed: IsoDate | undefined
      readonly expectedCount: number
      readonly observedCount: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentEligibleExecutionMissing'
      readonly featureLookbackSessions: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentProtocolHashFailed'
      readonly cause: CanonicalHashFailure
    }

export interface CandidateDevelopmentPreflightPass extends CandidateDevelopmentGeometryPass {
  readonly schemaVersion: 'bayn.candidate-development-preflight.v3'
  readonly attempt: CandidateDevelopmentBootstrapTailCapacity
  readonly featureLookbackSessions: number
  readonly firstEligibleExecution: CandidateDevelopmentExecutionBoundary
  readonly protocolIdentity: CandidateDevelopmentProtocolIdentity
  readonly doubledCostContract: typeof candidateDevelopmentDoubledCostContract
  readonly statisticsPolicy: typeof candidateDevelopmentStatisticsPolicy
  readonly comparisonSemantics: typeof candidateDevelopmentComparisonSemantics
  readonly selectedObservationSessions: readonly IsoDate[]
}

export type CandidateDevelopmentPreflightDecision = CandidateDevelopmentPreflightPass | CandidateDevelopmentGeometryFail

type CandidateDevelopmentComparisonGateKey = keyof typeof candidateDevelopmentComparisonSemantics.gates

export interface CandidateDevelopmentComparisonSemanticsEvidence {
  readonly schemaVersion: typeof candidateDevelopmentComparisonSemantics.evidence.schemaVersion
  readonly protocolHash: string
  readonly comparisonSemantics: typeof candidateDevelopmentComparisonSemantics
  readonly analysis: QualificationSelectedBenchmarkComparisonAnalysis
}

export type CandidateDevelopmentComparisonSemanticsIssue =
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid'
      readonly path: string
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSemanticsSchemaMismatch'
      readonly expected: CandidateDevelopmentComparisonSemanticsEvidence['schemaVersion']
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSemanticsProtocolMismatch'
      readonly expected: string
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonAnalysisFailed'
      readonly cause: QualificationStatisticsFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSeriesProjectionFailed'
      readonly cause: QualificationStatisticsFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentBaselineProtocolMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSeriesRunMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSeriesWindowMismatch'
      readonly index: number
      readonly expected: IsoDate | undefined
      readonly observed: IsoDate | undefined
      readonly expectedCount: number
      readonly observedCount: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonRebalanceScheduleMismatch'
      readonly index: number
      readonly expected: IsoDate | undefined
      readonly observed: IsoDate | undefined
      readonly expectedCount: number
      readonly observedCount: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonAnalysisSchemaMismatch'
      readonly expected: typeof candidateDevelopmentComparisonSemantics.evidence.analysisSchemaVersion
      readonly observed: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSemanticsHashFailed'
      readonly material: 'expected-evidence' | 'observed-evidence'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonBaselineMismatch'
      readonly gate: CandidateDevelopmentComparisonGateKey
      readonly expected: string
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentAnnualizedReturnComparisonMismatch'
      readonly expected: number
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentSelectedBenchmarkComparisonMismatch'
      readonly expected: string
      readonly observedBootstrap: unknown
      readonly observedWalkForward: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonEvidenceMismatch'
      readonly expectedHash: string
      readonly observedHash: string
    }

const comparisonEvidenceRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export const validateCandidateDevelopmentComparisonSeriesBinding = (
  preflight: CandidateDevelopmentPreflightPass,
  baseline: EvaluationResult,
  series: QualificationSeries,
): Result.Result<QualificationSeries, CandidateDevelopmentComparisonSemanticsIssue> => {
  if (baseline.protocolHash !== preflight.protocolIdentity.protocolHash) {
    return Result.fail({
      _tag: 'CandidateDevelopmentBaselineProtocolMismatch',
      expected: preflight.protocolIdentity.protocolHash,
      observed: baseline.protocolHash,
    })
  }
  if (series.runId !== baseline.runId) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSeriesRunMismatch',
      expected: baseline.runId,
      observed: series.runId,
    })
  }

  const expectedSessions = preflight.selectedObservationSessions
  const observedSessions = series.observations.map((observation) => observation.sessionDate)
  const sessionCount = Math.max(expectedSessions.length, observedSessions.length)
  for (let index = 0; index < sessionCount; index += 1) {
    const expected = expectedSessions.at(index)
    const observed = observedSessions.at(index)
    if (expected !== observed) {
      return Result.fail({
        _tag: 'CandidateDevelopmentComparisonSeriesWindowMismatch',
        index,
        expected,
        observed,
        expectedCount: expectedSessions.length,
        observedCount: observedSessions.length,
      })
    }
  }

  const expectedRebalanceExecutionDates = baseline.signalDecisions.map((decision) => decision.executionDate)
  const observedRebalanceExecutionDates = series.rebalanceExecutionDates
  const rebalanceCount = Math.max(expectedRebalanceExecutionDates.length, observedRebalanceExecutionDates.length)
  for (let index = 0; index < rebalanceCount; index += 1) {
    const expected = expectedRebalanceExecutionDates.at(index)
    const observed = observedRebalanceExecutionDates.at(index)
    if (expected !== observed) {
      return Result.fail({
        _tag: 'CandidateDevelopmentComparisonRebalanceScheduleMismatch',
        index,
        expected,
        observed,
        expectedCount: expectedRebalanceExecutionDates.length,
        observedCount: observedRebalanceExecutionDates.length,
      })
    }
  }

  return Result.succeed(series)
}

export const buildCandidateDevelopmentComparisonSemanticsEvidence = (
  preflight: CandidateDevelopmentPreflightPass,
  series: unknown,
): Result.Result<CandidateDevelopmentComparisonSemanticsEvidence, CandidateDevelopmentComparisonSemanticsIssue> =>
  pipe(
    analyzeSelectedBenchmarkComparisonInput(series, preflight.statisticsPolicy, preflight.attempt.priorTrialCount),
    Result.mapError(
      (cause): CandidateDevelopmentComparisonSemanticsIssue => ({
        _tag: 'CandidateDevelopmentComparisonAnalysisFailed',
        cause,
      }),
    ),
    Result.flatMap((analysis) =>
      analysis.schemaVersion === preflight.comparisonSemantics.evidence.analysisSchemaVersion
        ? Result.succeed({
            schemaVersion: candidateDevelopmentComparisonSemantics.evidence.schemaVersion,
            protocolHash: preflight.protocolIdentity.protocolHash,
            comparisonSemantics: preflight.comparisonSemantics,
            analysis,
          })
        : Result.fail({
            _tag: 'CandidateDevelopmentComparisonAnalysisSchemaMismatch' as const,
            expected: preflight.comparisonSemantics.evidence.analysisSchemaVersion,
            observed: analysis.schemaVersion,
          }),
    ),
  )

export const validateCandidateDevelopmentComparisonSemanticsEvidence = (
  preflight: CandidateDevelopmentPreflightPass,
  series: unknown,
  evidence: unknown,
): Result.Result<CandidateDevelopmentComparisonSemanticsEvidence, CandidateDevelopmentComparisonSemanticsIssue> => {
  const root = comparisonEvidenceRecord(evidence)
  if (root === undefined) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid',
      path: 'comparisonSemantics',
      observed: evidence,
    })
  }
  if (root.schemaVersion !== preflight.comparisonSemantics.evidence.schemaVersion) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSemanticsSchemaMismatch',
      expected: preflight.comparisonSemantics.evidence.schemaVersion,
      observed: root.schemaVersion,
    })
  }
  if (root.protocolHash !== preflight.protocolIdentity.protocolHash) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSemanticsProtocolMismatch',
      expected: preflight.protocolIdentity.protocolHash,
      observed: root.protocolHash,
    })
  }
  const observedSemantics = comparisonEvidenceRecord(root.comparisonSemantics)
  const observedGates = comparisonEvidenceRecord(observedSemantics?.gates)
  if (observedSemantics === undefined || observedGates === undefined) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid',
      path: 'comparisonSemantics.comparisonSemantics',
      observed: root.comparisonSemantics,
    })
  }
  const expectedGates = preflight.comparisonSemantics.gates
  const gateKeys = Object.keys(expectedGates) as CandidateDevelopmentComparisonGateKey[]
  for (const gate of gateKeys) {
    const expectedGate = expectedGates[gate]
    const observedGate = comparisonEvidenceRecord(observedGates[gate])
    if (observedGate === undefined) {
      return Result.fail({
        _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid',
        path: `comparisonSemantics.gates.${gate}`,
        observed: observedGates[gate],
      })
    }
    if (observedGate.baseline !== expectedGate.baseline) {
      return Result.fail({
        _tag: 'CandidateDevelopmentComparisonBaselineMismatch',
        gate,
        expected: expectedGate.baseline,
        observed: observedGate.baseline,
      })
    }
  }

  return pipe(
    buildCandidateDevelopmentComparisonSemanticsEvidence(preflight, series),
    Result.flatMap((expected) =>
      (() => {
        const observedAnalysis = comparisonEvidenceRecord(root.analysis)
        const observedBootstrap = comparisonEvidenceRecord(observedAnalysis?.bootstrap)
        const observedWalkForward = comparisonEvidenceRecord(observedAnalysis?.walkForward)
        if (observedAnalysis === undefined || observedBootstrap === undefined || observedWalkForward === undefined) {
          return Result.fail<CandidateDevelopmentComparisonSemanticsIssue>({
            _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid',
            path: 'comparisonSemantics.analysis',
            observed: root.analysis,
          })
        }
        if (
          observedBootstrap.annualizedReturnDifferenceLowerBound !==
          expected.analysis.bootstrap.annualizedReturnDifferenceLowerBound
        ) {
          return Result.fail<CandidateDevelopmentComparisonSemanticsIssue>({
            _tag: 'CandidateDevelopmentAnnualizedReturnComparisonMismatch',
            expected: expected.analysis.bootstrap.annualizedReturnDifferenceLowerBound,
            observed: observedBootstrap.annualizedReturnDifferenceLowerBound,
          })
        }
        if (
          observedBootstrap.selectedBenchmark !== expected.analysis.bootstrap.selectedBenchmark ||
          observedWalkForward.selectedBenchmark !== expected.analysis.walkForward.selectedBenchmark
        ) {
          return Result.fail<CandidateDevelopmentComparisonSemanticsIssue>({
            _tag: 'CandidateDevelopmentSelectedBenchmarkComparisonMismatch',
            expected: expected.analysis.bootstrap.selectedBenchmark,
            observedBootstrap: observedBootstrap.selectedBenchmark,
            observedWalkForward: observedWalkForward.selectedBenchmark,
          })
        }
        return pipe(
          Result.all({
            expectedHash: pipe(
              canonicalHashV1Result(expected),
              Result.mapError(
                (cause): CandidateDevelopmentComparisonSemanticsIssue => ({
                  _tag: 'CandidateDevelopmentComparisonSemanticsHashFailed',
                  material: 'expected-evidence',
                  cause,
                }),
              ),
            ),
            observedHash: pipe(
              canonicalHashV1Result(evidence),
              Result.mapError(
                (cause): CandidateDevelopmentComparisonSemanticsIssue => ({
                  _tag: 'CandidateDevelopmentComparisonSemanticsHashFailed',
                  material: 'observed-evidence',
                  cause,
                }),
              ),
            ),
          }),
          Result.flatMap(({ expectedHash, observedHash }) =>
            expectedHash === observedHash
              ? Result.succeed(evidence as CandidateDevelopmentComparisonSemanticsEvidence)
              : Result.fail<CandidateDevelopmentComparisonSemanticsIssue>({
                  _tag: 'CandidateDevelopmentComparisonEvidenceMismatch',
                  expectedHash,
                  observedHash,
                }),
          ),
        )
      })(),
    ),
  )
}

export type CandidateDevelopmentRunFailure =
  | {
      readonly _tag: 'CandidateDevelopmentPreflightInvalid'
      readonly cause: CandidateDevelopmentPreflightIssue
    }
  | {
      readonly _tag: 'CandidateDevelopmentPreflightFailed'
      readonly preflight: CandidateDevelopmentGeometryFail
    }
  | {
      readonly _tag: 'CandidateDevelopmentDoubledCostInvalid'
      readonly cause: CandidateDevelopmentDoubledCostIssue
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSemanticsInvalid'
      readonly cause: CandidateDevelopmentComparisonSemanticsIssue
    }

export interface CandidateDevelopmentPreflightInput {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly officialSessions: readonly IsoDate[]
  readonly signalSessionDates: readonly IsoDate[]
  readonly featureLookbackSessions: number
}

export interface CandidateDevelopmentEffects<Registration, Data, Error, Requirements> {
  readonly preregisterCandidate: (
    preflight: CandidateDevelopmentPreflightPass,
  ) => Effect.Effect<Registration, Error, Requirements>
  readonly loadDevelopmentData: (
    registration: Registration,
    preflight: CandidateDevelopmentPreflightPass,
  ) => Effect.Effect<Data, Error, Requirements>
  readonly evaluateDevelopment: (
    data: Data,
    preflight: CandidateDevelopmentPreflightPass,
  ) => Effect.Effect<CandidateDevelopmentEvaluation, Error, Requirements>
}

export interface CandidateDevelopmentEvaluation {
  readonly baseline: EvaluationResult
  readonly comparisonSemantics: CandidateDevelopmentComparisonSemanticsEvidence
  readonly stressed: CandidateDevelopmentDoubledCostRun
}

export interface CandidateDevelopmentDoubledCostEvidence {
  readonly baseline: CandidateDevelopmentDoubledCostRun
  readonly stressed: CandidateDevelopmentDoubledCostRun
}

export interface CandidateDevelopmentReport {
  readonly schemaVersion: typeof candidateDevelopmentComparisonSemantics.evidence.reportSchemaVersion
  readonly protocolIdentity: CandidateDevelopmentProtocolIdentity
  readonly comparisonSemantics: CandidateDevelopmentComparisonSemanticsEvidence
  readonly doubledCostContract: typeof candidateDevelopmentDoubledCostContract
  readonly doubledCost: CandidateDevelopmentDoubledCostEvidence
}

const validIsoDate = (value: string): value is IsoDate => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const positiveInteger = (
  field: Extract<
    CandidateDevelopmentGeometryIssue,
    { readonly _tag: 'CandidateDevelopmentGeometryPositiveIntegerRequired' }
  >['field'],
  value: number,
): Result.Result<number, CandidateDevelopmentGeometryIssue> =>
  !Number.isSafeInteger(value)
    ? Result.fail({ _tag: 'CandidateDevelopmentGeometryIntegerInvalid', field, value })
    : value <= 0
      ? Result.fail({ _tag: 'CandidateDevelopmentGeometryPositiveIntegerRequired', field, value })
      : Result.succeed(value)

const nonNegativeInteger = (
  field: 'firstExecutionIndex',
  value: number,
): Result.Result<number, CandidateDevelopmentGeometryIssue> =>
  !Number.isSafeInteger(value) || value < 0
    ? Result.fail({ _tag: 'CandidateDevelopmentGeometryIntegerInvalid', field, value })
    : Result.succeed(value)

export const requiredObservationsForWalkForward = (
  geometry: CandidateDevelopmentWalkForwardGeometry,
): Result.Result<number, CandidateDevelopmentGeometryIssue> =>
  pipe(
    Result.all({
      minimumTrainingSessions: positiveInteger('minimumTrainingSessions', geometry.minimumTrainingSessions),
      testSessions: positiveInteger('testSessions', geometry.testSessions),
      requiredFolds: positiveInteger('requiredFolds', geometry.requiredFolds),
    }),
    Result.flatMap(({ minimumTrainingSessions, requiredFolds, testSessions }) => {
      const requiredTestObservations = testSessions * requiredFolds
      if (!Number.isSafeInteger(requiredTestObservations)) {
        return Result.fail<CandidateDevelopmentGeometryIssue>({
          _tag: 'CandidateDevelopmentGeometryOverflow',
          operation: 'required-test-observations',
        })
      }
      const requiredObservations = minimumTrainingSessions + requiredTestObservations
      return Number.isSafeInteger(requiredObservations)
        ? Result.succeed(requiredObservations)
        : Result.fail<CandidateDevelopmentGeometryIssue>({
            _tag: 'CandidateDevelopmentGeometryOverflow',
            operation: 'required-observations',
          })
    }),
  )

export const availableObservationsAfterFirstExecution = (
  availableSessions: number,
  firstExecutionIndex: number,
): Result.Result<number, CandidateDevelopmentGeometryIssue> =>
  pipe(
    Result.all({
      availableSessions: positiveInteger('availableSessions', availableSessions),
      firstExecutionIndex: nonNegativeInteger('firstExecutionIndex', firstExecutionIndex),
    }),
    Result.flatMap(({ availableSessions: sessions, firstExecutionIndex: executionIndex }) =>
      executionIndex < sessions
        ? Result.succeed(sessions - executionIndex)
        : Result.fail<CandidateDevelopmentGeometryIssue>({
            _tag: 'CandidateDevelopmentExecutionOutsideCalendar',
            firstExecutionIndex: executionIndex,
            availableSessions: sessions,
          }),
    ),
  )

const requiredSession = (
  sessions: readonly IsoDate[],
  field: keyof CandidateDevelopmentFoldBoundary,
  index: number,
): Result.Result<IsoDate, CandidateDevelopmentGeometryIssue> => {
  const session = sessions.at(index)
  return session === undefined
    ? Result.fail({ _tag: 'CandidateDevelopmentFoldBoundaryMissing', field, index })
    : Result.succeed(session)
}

const buildFoldBoundary = (
  sessions: readonly IsoDate[],
  selectedObservationStartIndex: number,
  geometry: CandidateDevelopmentWalkForwardGeometry,
  ordinal: number,
): Result.Result<CandidateDevelopmentFoldBoundary, CandidateDevelopmentGeometryIssue> => {
  const trainingStartIndex = selectedObservationStartIndex
  const testStartIndex =
    selectedObservationStartIndex + geometry.minimumTrainingSessions + ordinal * geometry.testSessions
  const trainingEndIndex = testStartIndex - 1
  const testEndIndex = testStartIndex + geometry.testSessions - 1
  return pipe(
    Result.all({
      trainingStart: requiredSession(sessions, 'trainingStart', trainingStartIndex),
      trainingEnd: requiredSession(sessions, 'trainingEnd', trainingEndIndex),
      testStart: requiredSession(sessions, 'testStart', testStartIndex),
      testEnd: requiredSession(sessions, 'testEnd', testEndIndex),
    }),
    Result.map(({ testEnd, testStart, trainingEnd, trainingStart }) => ({
      ordinal,
      trainingStartIndex,
      trainingStart,
      trainingEndIndex,
      trainingEnd,
      trainingObservationCount: trainingEndIndex - trainingStartIndex + 1,
      testStartIndex,
      testStart,
      testEndIndex,
      testEnd,
      testObservationCount: geometry.testSessions,
    })),
  )
}

export const computeEndAnchoredWalkForwardBoundaries = (
  sessions: readonly IsoDate[],
  firstExecutionIndex: number,
  geometry: CandidateDevelopmentWalkForwardGeometry,
): Result.Result<CandidateDevelopmentGeometryDecision, CandidateDevelopmentGeometryIssue> =>
  pipe(
    Result.all({
      requiredObservations: requiredObservationsForWalkForward(geometry),
      availableObservations: availableObservationsAfterFirstExecution(sessions.length, firstExecutionIndex),
    }),
    Result.flatMap(
      ({
        availableObservations,
        requiredObservations,
      }): Result.Result<CandidateDevelopmentGeometryDecision, CandidateDevelopmentGeometryIssue> => {
        const availableFoldCount = Math.max(
          0,
          Math.floor((availableObservations - geometry.minimumTrainingSessions) / geometry.testSessions),
        )
        if (availableObservations < requiredObservations) {
          return Result.succeed({
            status: 'FAIL' as const,
            reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS' as const,
            requiredObservations,
            availableObservations,
            availableFoldCount,
            requiredFoldCount: geometry.requiredFolds,
            observationDeficit: requiredObservations - availableObservations,
          })
        }

        const selectedObservationStartIndex = sessions.length - requiredObservations
        const selectedObservationEndIndex = sessions.length - 1
        return pipe(
          Result.all({
            selectedObservationStart: requiredSession(sessions, 'trainingStart', selectedObservationStartIndex),
            selectedObservationEnd: requiredSession(sessions, 'testEnd', selectedObservationEndIndex),
            folds: Result.all(
              Array.from({ length: geometry.requiredFolds }, (_, ordinal) =>
                buildFoldBoundary(sessions, selectedObservationStartIndex, geometry, ordinal),
              ),
            ),
          }),
          Result.map(({ folds, selectedObservationEnd, selectedObservationStart }) => ({
            status: 'PASS' as const,
            requiredObservations,
            availableObservations,
            availableFoldCount,
            requiredFoldCount: geometry.requiredFolds,
            unusedEligibleObservations: selectedObservationStartIndex - firstExecutionIndex,
            selectedObservationStartIndex,
            selectedObservationStart,
            selectedObservationEndIndex,
            selectedObservationEnd,
            folds,
          })),
        )
      },
    ),
  )

export const officialMonthEndSignalDates = (sessions: readonly IsoDate[]): readonly IsoDate[] =>
  sessions.filter((session, index) => {
    const next = sessions.at(index + 1)
    return next !== undefined && session.slice(0, 7) !== next.slice(0, 7)
  })

export const firstEligibleExecutionAfterLookback = (
  sessions: readonly IsoDate[],
  signalSessionDates: readonly IsoDate[],
  featureLookbackSessions: number,
): Result.Result<CandidateDevelopmentExecutionBoundary, CandidateDevelopmentPreflightIssue> => {
  if (
    !Number.isSafeInteger(featureLookbackSessions) ||
    featureLookbackSessions < 0 ||
    featureLookbackSessions > candidateDevelopmentWalkForwardProtocol.maximumFeatureLookbackSessions
  ) {
    return Result.fail({
      _tag: 'CandidateDevelopmentLookbackInvalid',
      featureLookbackSessions,
      maximumFeatureLookbackSessions: candidateDevelopmentWalkForwardProtocol.maximumFeatureLookbackSessions,
    })
  }
  if (signalSessionDates.length === 0) {
    return Result.fail({ _tag: 'CandidateDevelopmentSignalScheduleEmpty' })
  }

  const sessionIndices = new Map(sessions.map((session, index) => [session, index] as const))
  for (let index = 0; index < signalSessionDates.length; index += 1) {
    const signalDate = signalSessionDates[index]
    const previous = index === 0 ? undefined : signalSessionDates[index - 1]
    if (previous !== undefined && previous >= signalDate) {
      return Result.fail({
        _tag: 'CandidateDevelopmentSignalScheduleNotStrictlyOrdered',
        index,
        previous,
        current: signalDate,
      })
    }
    const signalIndex = sessionIndices.get(signalDate)
    if (signalIndex === undefined) {
      return Result.fail({ _tag: 'CandidateDevelopmentSignalOutsideCalendar', signalDate })
    }
  }

  const expectedSignalSessionDates = officialMonthEndSignalDates(sessions)
  const scheduleLength = Math.max(expectedSignalSessionDates.length, signalSessionDates.length)
  for (let index = 0; index < scheduleLength; index += 1) {
    const expected = expectedSignalSessionDates.at(index)
    const observed = signalSessionDates.at(index)
    if (expected !== observed) {
      return Result.fail({
        _tag: 'CandidateDevelopmentSignalScheduleMismatch',
        index,
        expected,
        observed,
        expectedCount: expectedSignalSessionDates.length,
        observedCount: signalSessionDates.length,
      })
    }
  }

  for (const signalDate of signalSessionDates) {
    const signalIndex = sessionIndices.get(signalDate)
    if (signalIndex === undefined) {
      return Result.fail({ _tag: 'CandidateDevelopmentSignalOutsideCalendar', signalDate })
    }
    const executionDate = sessions.at(signalIndex + candidateDevelopmentWalkForwardProtocol.executionLagSessions)
    if (signalIndex >= featureLookbackSessions && executionDate !== undefined) {
      return Result.succeed({
        signalIndex,
        signalDate,
        executionIndex: signalIndex + candidateDevelopmentWalkForwardProtocol.executionLagSessions,
        executionDate,
      })
    }
  }

  return Result.fail({ _tag: 'CandidateDevelopmentEligibleExecutionMissing', featureLookbackSessions })
}

const validateFrozenDevelopmentCalendar = (
  sessions: readonly IsoDate[],
): Result.Result<void, CandidateDevelopmentPreflightIssue> => {
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]
    if (!validIsoDate(session)) {
      return Result.fail({ _tag: 'CandidateDevelopmentCalendarDateInvalid', index, value: session })
    }
    const previous = index === 0 ? undefined : sessions[index - 1]
    if (previous !== undefined && previous >= session) {
      return Result.fail({
        _tag: 'CandidateDevelopmentCalendarNotStrictlyOrdered',
        index,
        previous,
        current: session,
      })
    }
  }

  const exactFields = [
    ['sessionCount', candidateDevelopmentCalendarContract.sessionCount, sessions.length],
    ['start', candidateDevelopmentCalendarContract.start, sessions.at(0) ?? ''],
    ['end', candidateDevelopmentCalendarContract.end, sessions.at(-1) ?? ''],
  ] as const
  for (const [field, expected, observed] of exactFields) {
    if (observed !== expected) {
      return Result.fail({ _tag: 'CandidateDevelopmentCalendarMismatch', field, expected, observed })
    }
  }

  return pipe(
    canonicalHashV1Result({
      schemaVersion: candidateDevelopmentCalendarContract.schemaVersion,
      sessions,
    }),
    Result.mapError(
      (cause): CandidateDevelopmentPreflightIssue => ({
        _tag: 'CandidateDevelopmentCalendarHashFailed',
        cause,
      }),
    ),
    Result.flatMap((observed) =>
      observed === candidateDevelopmentCalendarContract.sessionsHash
        ? Result.succeed(undefined)
        : Result.fail<CandidateDevelopmentPreflightIssue>({
            _tag: 'CandidateDevelopmentCalendarMismatch',
            field: 'sessionsHash',
            expected: candidateDevelopmentCalendarContract.sessionsHash,
            observed,
          }),
    ),
  )
}

export const preflightCandidateDevelopment = (
  input: CandidateDevelopmentPreflightInput,
): Result.Result<CandidateDevelopmentPreflightDecision, CandidateDevelopmentPreflightIssue> =>
  pipe(
    bindCandidateDevelopmentAttempt(input.candidateOrdinal, input.priorTrialCount),
    Result.flatMap((attempt) =>
      pipe(
        validateFrozenDevelopmentCalendar(input.officialSessions),
        Result.flatMap(() =>
          firstEligibleExecutionAfterLookback(
            input.officialSessions,
            input.signalSessionDates,
            input.featureLookbackSessions,
          ),
        ),
        Result.map((firstEligibleExecution) => ({ attempt, firstEligibleExecution })),
      ),
    ),
    Result.flatMap(({ attempt, firstEligibleExecution }) =>
      pipe(
        Result.all({
          geometry: computeEndAnchoredWalkForwardBoundaries(
            input.officialSessions,
            firstEligibleExecution.executionIndex,
            candidateDevelopmentWalkForwardProtocol,
          ),
          protocolIdentity: pipe(
            identifyCandidateDevelopmentProtocol(attempt, input.featureLookbackSessions),
            Result.mapError(
              (cause): CandidateDevelopmentPreflightIssue => ({
                _tag: 'CandidateDevelopmentProtocolHashFailed',
                cause,
              }),
            ),
          ),
        }),
        Result.map(
          ({ geometry, protocolIdentity }): CandidateDevelopmentPreflightDecision =>
            geometry.status === 'FAIL'
              ? geometry
              : {
                  ...geometry,
                  schemaVersion: 'bayn.candidate-development-preflight.v3',
                  attempt,
                  featureLookbackSessions: input.featureLookbackSessions,
                  firstEligibleExecution,
                  protocolIdentity,
                  doubledCostContract: candidateDevelopmentDoubledCostContract,
                  statisticsPolicy: candidateDevelopmentStatisticsPolicy,
                  comparisonSemantics: candidateDevelopmentComparisonSemantics,
                  selectedObservationSessions: input.officialSessions.slice(
                    geometry.selectedObservationStartIndex,
                    geometry.selectedObservationEndIndex + 1,
                  ),
                },
        ),
      ),
    ),
  )

export const runCandidateDevelopment = <Registration, Data, Error, Requirements>(
  input: CandidateDevelopmentPreflightInput,
  effects: CandidateDevelopmentEffects<Registration, Data, Error, Requirements>,
): Effect.Effect<CandidateDevelopmentReport, CandidateDevelopmentRunFailure | Error, Requirements> =>
  Effect.fromResult(preflightCandidateDevelopment(input)).pipe(
    Effect.mapError(
      (cause): CandidateDevelopmentRunFailure => ({ _tag: 'CandidateDevelopmentPreflightInvalid', cause }),
    ),
    Effect.flatMap(
      (preflight): Effect.Effect<CandidateDevelopmentReport, CandidateDevelopmentRunFailure | Error, Requirements> =>
        preflight.status === 'FAIL'
          ? Effect.fail<CandidateDevelopmentRunFailure>({
              _tag: 'CandidateDevelopmentPreflightFailed',
              preflight,
            })
          : effects.preregisterCandidate(preflight).pipe(
              Effect.flatMap((registration) => effects.loadDevelopmentData(registration, preflight)),
              Effect.flatMap((data) => effects.evaluateDevelopment(data, preflight)),
              Effect.flatMap((evaluation) =>
                Effect.fromResult(
                  pipe(
                    prepareQualificationSeries(evaluation.baseline),
                    Result.mapError(
                      (cause): CandidateDevelopmentComparisonSemanticsIssue => ({
                        _tag: 'CandidateDevelopmentComparisonSeriesProjectionFailed',
                        cause,
                      }),
                    ),
                    Result.flatMap((series) =>
                      validateCandidateDevelopmentComparisonSeriesBinding(preflight, evaluation.baseline, series),
                    ),
                  ),
                ).pipe(
                  Effect.mapError(
                    (cause): CandidateDevelopmentRunFailure => ({
                      _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
                      cause,
                    }),
                  ),
                  Effect.flatMap((comparisonSeries) =>
                    Effect.fromResult(
                      validateCandidateDevelopmentComparisonSemanticsEvidence(
                        preflight,
                        comparisonSeries,
                        evaluation.comparisonSemantics,
                      ),
                    ).pipe(
                      Effect.mapError(
                        (cause): CandidateDevelopmentRunFailure => ({
                          _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
                          cause,
                        }),
                      ),
                    ),
                  ),
                  Effect.flatMap((comparisonSemantics) => {
                    const baseline = {
                      signalDecisions: evaluation.baseline.signalDecisions,
                      simulation: evaluation.baseline.simulation,
                    }
                    const doubledCost = { baseline, stressed: evaluation.stressed }
                    return Effect.fromResult(
                      validateCandidateDevelopmentDoubledCostCausalPath(baseline, evaluation.stressed),
                    ).pipe(
                      Effect.mapError(
                        (cause): CandidateDevelopmentRunFailure => ({
                          _tag: 'CandidateDevelopmentDoubledCostInvalid',
                          cause,
                        }),
                      ),
                      Effect.map(() => ({
                        schemaVersion: preflight.comparisonSemantics.evidence.reportSchemaVersion,
                        protocolIdentity: preflight.protocolIdentity,
                        comparisonSemantics,
                        doubledCostContract: preflight.doubledCostContract,
                        doubledCost,
                      })),
                    )
                  }),
                ),
              ),
            ),
    ),
  )
