import {
  candidateDevelopmentStatisticsPolicy,
  type CandidateDevelopmentDoubledCostRun,
  type CandidateDevelopmentPreflightPass,
} from '../candidate-development'
import { defaultExecutionModel } from '../execution-model'
import type { CanonicalHashFailure } from '../hash'
import type { AlignedSession, SimulationFailure, SimulationResult, SimulationTarget } from '../simulation'
import type {
  DecisionPlan,
  EconomicVerdict,
  IsoDate,
  PerformanceMetrics,
  SimulationProtocol,
  SimulationTrace,
} from '../types'

export const CANDIDATE_14_ORDINAL = 14 as const
export const CANDIDATE_14_PRIOR_TRIAL_COUNT = 13 as const
export const CANDIDATE_14_STRATEGY_NAME = 'intraday-information-continuation-rotation' as const
export const CANDIDATE_14_STRATEGY_VERSION = '1.0.0' as const
export const CANDIDATE_14_DEVELOPMENT_START = '2016-01-04' as const
export const CANDIDATE_14_DEVELOPMENT_END = '2022-12-30' as const
export const CANDIDATE_14_HOLDOUT_START = '2023-01-03' as const
export const CANDIDATE_14_HOLDOUT_END = '2025-12-31' as const
export const CANDIDATE_14_SNAPSHOT_ID = '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0'
export const CANDIDATE_14_PREREGISTRATION_SHA256 = 'd25b2a4f547d0460f04a6e0990cb8fc1284981947122065c29da2ad4df473ea5'
export const CANDIDATE_14_PREREGISTRATION_COMMIT = '48a797c314799ea8315bb12fc743566ecaedc62c'
export const CANDIDATE_14_PROTOCOL_HASH = '667a7f11b5fd317e20033457b6faa9225a52fe78d3fb40c271dfe72811d191fc'

export const candidate14Universe = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const
export type Candidate14Symbol = (typeof candidate14Universe)[number]
export type Candidate14Challenger = Exclude<Candidate14Symbol, 'SPY'>

export const candidate14Specifications = [
  {
    id: 'intraday-relative-126-exposure90',
    lookbackSessions: 126,
    selectedWeight: 0.9,
    cashReserveWeight: 0.1,
    minimumRelativeIntradayReturn: 0,
  },
] as const
export type Candidate14Specification = (typeof candidate14Specifications)[number]
export type Candidate14SpecificationId = Candidate14Specification['id']

export const candidate14DevelopmentStatisticsPolicy = candidateDevelopmentStatisticsPolicy
export const candidate14SelectionMultiplicity = candidate14Specifications.length

export const candidate14Protocol = {
  schemaVersion: 'bayn.intraday-information-continuation.protocol.v1',
  candidateOrdinal: CANDIDATE_14_ORDINAL,
  priorTrialCount: CANDIDATE_14_PRIOR_TRIAL_COUNT,
  strategyName: CANDIDATE_14_STRATEGY_NAME,
  strategyVersion: CANDIDATE_14_STRATEGY_VERSION,
  universe: candidate14Universe,
  dataValidity: {
    minimumAdjustedPrice: 5,
    requirePositiveVolume: true,
  },
  feature: {
    name: 'relative-cumulative-intraday-return' as const,
    declaredLookbackSessions: 126,
    return: 'same-session-adjusted-open-to-adjusted-close-gross' as const,
    cumulative: 'product-of-126-intraday-gross-returns-minus-one' as const,
    relative: 'challenger-cumulative-minus-spy-cumulative' as const,
    score: 'relative-intraday-return' as const,
  },
  allocation: {
    selectedWeight: 0.9,
    cashReserveWeight: 0.1,
    fallbackSymbol: 'SPY' as const,
    selection: 'score-descending' as const,
    tieBreak: 'ascending-symbol' as const,
    minimumScore: 0,
    grossExposure: 0.9,
    maximumPositionCount: 1,
  },
  schedule: {
    signal: 'canonical-official-month-end-finalized-close' as const,
    execution: 'next-official-session-open' as const,
    terminalSignalDate: '2022-12-29' as const,
    terminalExecutionDate: CANDIDATE_14_DEVELOPMENT_END,
  },
  selection: {
    specifications: candidate14Specifications,
    maximumSpecifications: candidate14Specifications.length,
    precedingAttempts: CANDIDATE_14_PRIOR_TRIAL_COUNT,
    familyOneSidedAlpha: candidate14DevelopmentStatisticsPolicy.confidence.familyOneSidedAlpha,
    selectionMultiplicity: candidate14SelectionMultiplicity,
    order: ['sole-specification-must-pass-all-gates'] as const,
  },
} as const

export const candidate14SimulationProtocol: SimulationProtocol = {
  universe: candidate14Protocol.universe,
  directVolatilityTarget: 0.1,
  initialCapitalMicros: '1000000000000',
  executionModel: defaultExecutionModel,
  thresholds: {
    minimumObservations: 504,
    minimumAnnualizedReturn: 0,
    minimumSharpeImprovement: 0,
    maximumDrawdown: 0.35,
    maximumAnnualTurnover: 12,
    requirePositiveDoubleCostReturn: true,
  },
}

export const candidate14PriorAttemptIds = [
  '300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47',
  '36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c',
  '440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861',
  '70763f839afd9359a34ea70dd833bf7a6fb1553aad98921b8f25282851fcf773',
  '7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32',
  '87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f',
  '8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be',
  '8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc',
  '9c495c857a67659a56ca9381ff03d6839cf1812abbf70c73bc75de372bcaf118',
  'a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217',
  'b38d784ce8124bbbff7513a9f8c94ec6ac4d51d7c01bf5c369bcfe3bc5aa2183',
  'b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7',
  'bf19a5d8b29032146effeadca2bf129924c9062dd5b516a0483927207c333cfc',
] as const

export const candidate14BehaviorMaterial = {
  schemaVersion: 'bayn.intraday-information-continuation.behavior.v1',
  input: '126-adjusted-open-close-pairs-ending-at-each-finalized-month-end',
  return: 'same-session-adjusted-close-divided-by-adjusted-open',
  cumulative: 'product-of-126-intraday-gross-returns-minus-one',
  score: 'challenger-cumulative-intraday-return-minus-spy-cumulative-intraday-return',
  eligibility: 'score-strictly-greater-than-zero',
  selection: 'greatest-score-then-ascending-symbol-otherwise-spy',
  allocation: '90-percent-selected-symbol-and-10-percent-cash',
  cashReserve: 'ten-percent-analytical-invariant-cost-path-reserve',
  minimumAdjustedPrice: 'five-us-dollars-for-frozen-fee-envelope',
  schedule: 'official-month-end-finalized-close-to-next-session-open',
  universe: 'DBC-EFA-IEF-SPY-VNQ-long-only-unlevered',
  excludedSignals: 'overnight-close-to-close-volume-volatility-covariance-seasonality-regression-residual-skip-period',
  missingData: 'fail-closed-no-imputation',
  futureData: 'decision-ignores-every-bar-after-the-finalized-signal-close',
  terminal: '2022-12-29-finalized-close-to-2022-12-30-open-all-cash',
  doubledCost: 'fixed-baseline-signal-and-requested-filled-quantity-path-repriced-at-exactly-two-times-cost',
} as const

const fullMarketClosures = new Set<IsoDate>([
  '2016-01-18',
  '2016-02-15',
  '2016-03-25',
  '2016-05-30',
  '2016-07-04',
  '2016-09-05',
  '2016-11-24',
  '2016-12-26',
  '2017-01-02',
  '2017-01-16',
  '2017-02-20',
  '2017-04-14',
  '2017-05-29',
  '2017-07-04',
  '2017-09-04',
  '2017-11-23',
  '2017-12-25',
  '2018-01-01',
  '2018-01-15',
  '2018-02-19',
  '2018-03-30',
  '2018-05-28',
  '2018-07-04',
  '2018-09-03',
  '2018-11-22',
  '2018-12-05',
  '2018-12-25',
  '2019-01-01',
  '2019-01-21',
  '2019-02-18',
  '2019-04-19',
  '2019-05-27',
  '2019-07-04',
  '2019-09-02',
  '2019-11-28',
  '2019-12-25',
  '2020-01-01',
  '2020-01-20',
  '2020-02-17',
  '2020-04-10',
  '2020-05-25',
  '2020-07-03',
  '2020-09-07',
  '2020-11-26',
  '2020-12-25',
  '2021-01-01',
  '2021-01-18',
  '2021-02-15',
  '2021-04-02',
  '2021-05-31',
  '2021-07-05',
  '2021-09-06',
  '2021-11-25',
  '2021-12-24',
  '2022-01-17',
  '2022-02-21',
  '2022-04-15',
  '2022-05-30',
  '2022-06-20',
  '2022-07-04',
  '2022-09-05',
  '2022-11-24',
  '2022-12-26',
])

export const candidate14DevelopmentSessions = (): readonly IsoDate[] => {
  const sessions: IsoDate[] = []
  for (
    let date = new Date(`${CANDIDATE_14_DEVELOPMENT_START}T00:00:00.000Z`);
    date <= new Date(`${CANDIDATE_14_DEVELOPMENT_END}T00:00:00.000Z`);
    date = new Date(date.getTime() + 86_400_000)
  ) {
    const session = date.toISOString().slice(0, 10) as IsoDate
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !fullMarketClosures.has(session)) sessions.push(session)
  }
  return sessions
}

export interface Candidate14Bar {
  readonly symbol: Candidate14Symbol
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface Candidate14Dataset {
  readonly snapshotId: string
  readonly sessions: readonly IsoDate[]
  readonly bars: readonly Candidate14Bar[]
  readonly sessionsContentHash: string
  readonly barsContentHash: string
}

export interface Candidate14Registration {
  readonly preregistrationHash: typeof CANDIDATE_14_PREREGISTRATION_SHA256
  readonly preregistrationCommit: typeof CANDIDATE_14_PREREGISTRATION_COMMIT
  readonly evaluatedCommit: string
}

export interface Candidate14Plan {
  readonly specification: Candidate14Specification
  readonly targets: readonly SimulationTarget[]
  readonly rebalanceExecutionDates: readonly IsoDate[]
  readonly simulationStartIndex: number
  readonly evaluationStartIndex: number
}

export interface Candidate14Feature {
  readonly symbol: Candidate14Challenger
  readonly windowStart: IsoDate
  readonly windowEnd: IsoDate
  readonly challengerCumulativeIntradayReturn: number
  readonly spyCumulativeIntradayReturn: number
  readonly score: number
  readonly eligible: boolean
}

export interface Candidate14SignalDecision {
  readonly signalDate: IsoDate
  readonly executionDate: IsoDate
  readonly specification: Candidate14Specification
  readonly features: readonly Candidate14Feature[]
  readonly selectedSymbol: Candidate14Challenger | null
  readonly weights: Readonly<Record<Candidate14Symbol, number>>
  readonly decisionPlan: DecisionPlan
}

export interface Candidate14PreparedData {
  readonly dataset: Candidate14Dataset
  readonly sessions: readonly AlignedSession[]
}

export interface Candidate14CostReplay {
  readonly result: Omit<SimulationResult, 'simulation'> & { readonly simulation: SimulationTrace }
  readonly terminalCash: boolean
}

export interface Candidate14UncertaintyEvidence {
  readonly status: 'PASS' | 'REJECTED' | 'INSUFFICIENT'
  readonly reasonCodes: readonly string[]
  readonly adjustedOneSidedAlpha: number
  readonly producedBootstrapSamples: number
  readonly bootstrapSamplesHash: string
  readonly annualizedExcessReturnLowerBound: number
  readonly sharpeDifferenceLowerBound: number
  readonly completeRebalanceBlocks: number
  readonly requiredCompleteRebalanceBlocks: number
  readonly availableCompleteSessions: number
  readonly requiredCompleteSessions: number
  readonly walkForwardFolds: readonly {
    readonly ordinal: number
    readonly trainingStart: IsoDate
    readonly trainingEnd: IsoDate
    readonly testStart: IsoDate
    readonly testEnd: IsoDate
    readonly testObservationCount: number
    readonly excessReturn: number
    readonly maximumDrawdown: number
    readonly positiveExcess: boolean
  }[]
  readonly positiveWalkForwardFolds: number
  readonly analysisHash: string
}

export interface Candidate14SpecificationReport {
  readonly specification: Candidate14Specification
  readonly identity: {
    readonly strategyHash: string
    readonly runId: string
  }
  readonly metrics: {
    readonly strategy: PerformanceMetrics
    readonly buyAndHold: PerformanceMetrics
    readonly directVolatility: PerformanceMetrics
    readonly doubleCostStrategy: PerformanceMetrics
    readonly benchmarkRelativeAnnualizedReturn: number
    readonly benchmarkSharpeDifference: number
  }
  readonly selectedBenchmark: 'buy-and-hold' | 'direct-volatility-timing'
  readonly economicVerdict: EconomicVerdict
  readonly terminalCash: {
    readonly strategy: boolean
    readonly buyAndHold: boolean
    readonly directVolatility: boolean
    readonly doubleCostStrategy: boolean
  }
  readonly doubledCostCausalPath: {
    readonly schemaVersion: 'bayn.candidate-development-doubled-cost-check.v1'
    readonly status: 'PASS'
    readonly signalDecisionsHash: string
    readonly orderQuantityPathHash: string
    readonly executionModelHash: string
  }
  readonly uncertainty: Candidate14UncertaintyEvidence
  readonly developmentPass: boolean
}

export interface Candidate14DevelopmentReport {
  readonly schemaVersion: 'bayn.candidate-14-development-report.v1'
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly evaluatedCommit: string
  readonly preregistrationHash: typeof CANDIDATE_14_PREREGISTRATION_SHA256
  readonly preregistrationCommit: typeof CANDIDATE_14_PREREGISTRATION_COMMIT
  readonly identity: {
    readonly parameterHash: string
    readonly behaviorHash: string
    readonly familyStrategyHash: string
    readonly familyRunId: string
    readonly reportHash: string
  }
  readonly dataset: {
    readonly snapshotId: string
    readonly firstSession: IsoDate
    readonly lastSession: IsoDate
    readonly sessionCount: number
    readonly barCount: number
    readonly sessionsContentHash: string
    readonly barsContentHash: string
  }
  readonly geometry: CandidateDevelopmentPreflightPass
  readonly selection: {
    readonly specificationCount: number
    readonly familyMultiplicityDivisor: number
    readonly priorAttemptCount: number
    readonly adjustedOneSidedAlpha: number
    readonly selectedSpecificationId: Candidate14SpecificationId | null
  }
  readonly specifications: readonly Candidate14SpecificationReport[]
  readonly holdout: {
    readonly start: typeof CANDIDATE_14_HOLDOUT_START
    readonly end: typeof CANDIDATE_14_HOLDOUT_END
    readonly inspected: false
    readonly accessCount: 0
  }
}

export interface Candidate14DevelopmentEvaluation {
  readonly report: Candidate14DevelopmentReport
  readonly doubledCost: {
    readonly baseline: CandidateDevelopmentDoubledCostRun
    readonly stressed: CandidateDevelopmentDoubledCostRun
  }
}

export type Candidate14Failure =
  | { readonly _tag: 'Candidate14InvalidInput'; readonly operation: string; readonly reason: string }
  | { readonly _tag: 'Candidate14HashFailure'; readonly operation: string; readonly cause: CanonicalHashFailure }
  | { readonly _tag: 'Candidate14SimulationFailure'; readonly simulation: string; readonly cause: SimulationFailure }
  | { readonly _tag: 'Candidate14QualificationFailure'; readonly cause: unknown }
  | {
      readonly _tag: 'Candidate14DoubledCostReplayInvalid'
      readonly disposition: 'INVALID_PROTOCOL_DEVIATION'
      readonly reason: string
    }
  | { readonly _tag: 'Candidate14IoFailure'; readonly operation: string; readonly cause: unknown }
