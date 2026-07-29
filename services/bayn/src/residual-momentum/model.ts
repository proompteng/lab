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

export const CANDIDATE_13_ORDINAL = 13 as const
export const CANDIDATE_13_PRIOR_TRIAL_COUNT = 12 as const
export const CANDIDATE_13_STRATEGY_NAME = 'spy-residual-momentum-rotation' as const
export const CANDIDATE_13_STRATEGY_VERSION = '1.0.0' as const
export const CANDIDATE_13_DEVELOPMENT_START = '2016-01-04' as const
export const CANDIDATE_13_DEVELOPMENT_END = '2022-12-30' as const
export const CANDIDATE_13_HOLDOUT_START = '2023-01-03' as const
export const CANDIDATE_13_HOLDOUT_END = '2025-12-31' as const
export const CANDIDATE_13_SNAPSHOT_ID = '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0'
export const CANDIDATE_13_PREREGISTRATION_SHA256 = '69d9f06cc53cc54265279ad969396bc6fa5d0aedea1c50eda78313a22d444af8'
export const CANDIDATE_13_PREREGISTRATION_COMMIT = '3e8edb4f15d54f9d6be177c411062c3ee614c992'
export const CANDIDATE_13_PROTOCOL_HASH = 'e9cc365a8b1c2cffe2aa37b496387000695e2a78d1093ad36e142261eab88454'

export const candidate13Universe = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const
export type Candidate13Symbol = (typeof candidate13Universe)[number]
export type Candidate13Challenger = Exclude<Candidate13Symbol, 'SPY'>

export const candidate13Specifications = [
  {
    id: 'spy-residual-231-skip21-core49_5-active49_5',
    regressionReturnCount: 252,
    formationReturnCount: 231,
    skippedRecentReturnCount: 21,
    spyCoreWeight: 0.495,
    challengerWeight: 0.495,
    fallbackSpyWeight: 0.99,
    minimumScore: 0,
  },
] as const
export type Candidate13Specification = (typeof candidate13Specifications)[number]
export type Candidate13SpecificationId = Candidate13Specification['id']

export const candidate13DevelopmentStatisticsPolicy = candidateDevelopmentStatisticsPolicy
export const candidate13SelectionMultiplicity = candidate13Specifications.length

export const candidate13Protocol = {
  schemaVersion: 'bayn.spy-residual-momentum.protocol.v1',
  candidateOrdinal: CANDIDATE_13_ORDINAL,
  priorTrialCount: CANDIDATE_13_PRIOR_TRIAL_COUNT,
  strategyName: CANDIDATE_13_STRATEGY_NAME,
  strategyVersion: CANDIDATE_13_STRATEGY_VERSION,
  universe: candidate13Universe,
  feature: {
    name: 'spy-factor-residual-momentum' as const,
    declaredLookbackSessions: 252,
    return: 'adjusted-close-to-close-simple' as const,
    regression: 'ols-with-intercept-challenger-on-spy-over-252-returns' as const,
    rankingResidual: 'challenger-return-minus-beta-times-spy-return-alpha-omitted' as const,
    formationReturnCount: 231,
    skippedRecentReturnCount: 21,
    score: 'formation-mean-divided-by-formation-sample-standard-deviation' as const,
  },
  allocation: {
    eligible: { SPY: 0.495, challenger: 0.495, cash: 0.01 },
    fallback: { SPY: 0.99, cash: 0.01 },
    selection: 'score-descending' as const,
    tieBreak: 'ascending-symbol' as const,
    minimumScore: 0,
    grossExposure: 0.99,
    maximumPositionCount: 2,
  },
  schedule: {
    signal: 'canonical-official-month-end-finalized-close' as const,
    execution: 'next-official-session-open' as const,
    terminalSignalDate: '2022-12-29' as const,
    terminalExecutionDate: CANDIDATE_13_DEVELOPMENT_END,
  },
  selection: {
    specifications: candidate13Specifications,
    maximumSpecifications: candidate13Specifications.length,
    precedingAttempts: CANDIDATE_13_PRIOR_TRIAL_COUNT,
    familyOneSidedAlpha: candidate13DevelopmentStatisticsPolicy.confidence.familyOneSidedAlpha,
    selectionMultiplicity: candidate13SelectionMultiplicity,
    order: ['sole-specification-must-pass-all-gates'] as const,
  },
} as const

export const candidate13SimulationProtocol: SimulationProtocol = {
  universe: candidate13Protocol.universe,
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

export const candidate13PriorAttemptIds = [
  '300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47',
  '36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c',
  '440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861',
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

export const candidate13BehaviorMaterial = {
  schemaVersion: 'bayn.spy-residual-momentum.behavior.v1',
  input: '253-adjusted-closes-ending-at-each-finalized-month-end',
  return: '252-close-to-close-simple-returns',
  regression: 'ols-with-intercept-each-challenger-on-spy-over-all-252-returns',
  residual: 'challenger-return-minus-estimated-beta-times-spy-return-with-estimated-alpha-omitted',
  formation: 'first-231-residualized-returns-with-most-recent-21-returns-skipped',
  score: 'formation-mean-divided-by-formation-sample-standard-deviation',
  eligibility: 'score-strictly-greater-than-zero',
  selection: 'greatest-score-then-ascending-symbol',
  allocation: '49.5-percent-spy-plus-49.5-percent-selected-challenger-otherwise-99-percent-spy',
  cashReserve: 'one-percent-unborrowed-invariant-cost-path-reserve',
  schedule: 'official-month-end-finalized-close-to-next-session-open',
  universe: 'DBC-EFA-IEF-SPY-VNQ-long-only-unlevered',
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

export const candidate13DevelopmentSessions = (): readonly IsoDate[] => {
  const sessions: IsoDate[] = []
  for (
    let date = new Date(`${CANDIDATE_13_DEVELOPMENT_START}T00:00:00.000Z`);
    date <= new Date(`${CANDIDATE_13_DEVELOPMENT_END}T00:00:00.000Z`);
    date = new Date(date.getTime() + 86_400_000)
  ) {
    const session = date.toISOString().slice(0, 10) as IsoDate
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !fullMarketClosures.has(session)) sessions.push(session)
  }
  return sessions
}

export interface Candidate13Bar {
  readonly symbol: Candidate13Symbol
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface Candidate13Dataset {
  readonly snapshotId: string
  readonly sessions: readonly IsoDate[]
  readonly bars: readonly Candidate13Bar[]
  readonly sessionsContentHash: string
  readonly barsContentHash: string
}

export interface Candidate13Registration {
  readonly preregistrationHash: typeof CANDIDATE_13_PREREGISTRATION_SHA256
  readonly preregistrationCommit: typeof CANDIDATE_13_PREREGISTRATION_COMMIT
  readonly evaluatedCommit: string
}

export interface Candidate13Plan {
  readonly specification: Candidate13Specification
  readonly targets: readonly SimulationTarget[]
  readonly rebalanceExecutionDates: readonly IsoDate[]
  readonly simulationStartIndex: number
  readonly evaluationStartIndex: number
}

export interface Candidate13Feature {
  readonly symbol: Candidate13Challenger
  readonly regressionStart: IsoDate
  readonly regressionEnd: IsoDate
  readonly formationEnd: IsoDate
  readonly beta: number
  readonly formationMean: number
  readonly formationStandardDeviation: number
  readonly score: number
  readonly eligible: boolean
}

export interface Candidate13SignalDecision {
  readonly signalDate: IsoDate
  readonly executionDate: IsoDate
  readonly specification: Candidate13Specification
  readonly features: readonly Candidate13Feature[]
  readonly selectedSymbol: Candidate13Challenger | null
  readonly weights: Readonly<Record<Candidate13Symbol, number>>
  readonly decisionPlan: DecisionPlan
}

export interface Candidate13PreparedData {
  readonly dataset: Candidate13Dataset
  readonly sessions: readonly AlignedSession[]
}

export interface Candidate13CostReplay {
  readonly result: Omit<SimulationResult, 'simulation'> & { readonly simulation: SimulationTrace }
  readonly terminalCash: boolean
}

export interface Candidate13UncertaintyEvidence {
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

export interface Candidate13SpecificationReport {
  readonly specification: Candidate13Specification
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
  readonly uncertainty: Candidate13UncertaintyEvidence
  readonly developmentPass: boolean
}

export interface Candidate13DevelopmentReport {
  readonly schemaVersion: 'bayn.candidate-13-development-report.v1'
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly evaluatedCommit: string
  readonly preregistrationHash: typeof CANDIDATE_13_PREREGISTRATION_SHA256
  readonly preregistrationCommit: typeof CANDIDATE_13_PREREGISTRATION_COMMIT
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
    readonly selectedSpecificationId: Candidate13SpecificationId | null
  }
  readonly specifications: readonly Candidate13SpecificationReport[]
  readonly holdout: {
    readonly start: typeof CANDIDATE_13_HOLDOUT_START
    readonly end: typeof CANDIDATE_13_HOLDOUT_END
    readonly inspected: false
    readonly accessCount: 0
  }
}

export interface Candidate13DevelopmentEvaluation {
  readonly report: Candidate13DevelopmentReport
  readonly doubledCost: {
    readonly baseline: CandidateDevelopmentDoubledCostRun
    readonly stressed: CandidateDevelopmentDoubledCostRun
  }
}

export type Candidate13Failure =
  | { readonly _tag: 'Candidate13InvalidInput'; readonly operation: string; readonly reason: string }
  | { readonly _tag: 'Candidate13HashFailure'; readonly operation: string; readonly cause: CanonicalHashFailure }
  | { readonly _tag: 'Candidate13SimulationFailure'; readonly simulation: string; readonly cause: SimulationFailure }
  | { readonly _tag: 'Candidate13QualificationFailure'; readonly cause: unknown }
  | {
      readonly _tag: 'Candidate13DoubledCostReplayInvalid'
      readonly disposition: 'INVALID_PROTOCOL_DEVIATION'
      readonly reason: string
    }
  | { readonly _tag: 'Candidate13IoFailure'; readonly operation: string; readonly cause: unknown }
