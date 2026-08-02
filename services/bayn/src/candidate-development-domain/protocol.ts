import {
  makeQualificationStatisticsPolicy,
  qualificationPolicyMaximumCandidateOrdinal,
  qualificationSelectedBenchmarkRule,
  type QualificationStatisticsPolicy,
} from '../qualification-statistics'

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
 * Development and terminal qualification share one ordinal-bound statistics policy. Its paired complete-block bootstrap
 * samples only observed, non-wrapping rebalance blocks, following the dependent block-resampling principle of Künsch
 * (1989, doi:10.1214/aos/1176347265).
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
  maximumCandidateOrdinal: qualificationPolicyMaximumCandidateOrdinal,
  ordinalBinding: 'candidate-ordinal-equals-prior-trial-count-plus-one',
} as const

export const candidateDevelopmentRebalanceScheduleContract = {
  schemaVersion: 'bayn.candidate-development-rebalance-schedule.v1',
  signalSchedule: 'official-month-end-sessions',
  executionSchedule: 'next-official-session',
  comparisonWindow: 'selected-observation-window-inclusive',
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

export const candidateDevelopmentStatisticsPolicy = makeQualificationStatisticsPolicy({
  maximumCandidateOrdinal: candidateDevelopmentAttemptHorizon.maximumCandidateOrdinal,
  walkForward: {
    testSessions: candidateDevelopmentWalkForwardProtocol.testSessions,
    minimumFolds: candidateDevelopmentWalkForwardProtocol.requiredFolds,
  },
}) satisfies QualificationStatisticsPolicy

export const candidateDevelopmentComparisonSemantics = {
  schemaVersion: 'bayn.candidate-development-comparison-semantics.v2',
  selectedBenchmarkRule: qualificationSelectedBenchmarkRule,
  evidence: {
    schemaVersion: 'bayn.candidate-development-comparison-semantics-evidence.v3',
    reportSchemaVersion: 'bayn.candidate-development-report.v2',
    analysisSchemaVersion: 'bayn.selected-benchmark-comparison-analysis.v1',
    source: 'baseline-evaluation-result',
    seriesProjection: 'prepare-qualification-series',
    windowBinding: 'exact-selected-preflight-sessions',
    rebalanceBinding: 'official-signal-next-session-executions',
    strategyProtocolBinding: 'explicit-expected-strategy-protocol-hash',
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
  schemaVersion: 'bayn.candidate-development-protocol.v4',
  calendar: candidateDevelopmentCalendarContract,
  walkForward: candidateDevelopmentWalkForwardProtocol,
  attemptHorizon: candidateDevelopmentAttemptHorizon,
  rebalanceSchedule: candidateDevelopmentRebalanceScheduleContract,
  doubledCost: candidateDevelopmentDoubledCostContract,
  statisticsPolicy: candidateDevelopmentStatisticsPolicy,
  comparisonSemantics: candidateDevelopmentComparisonSemantics,
} as const
