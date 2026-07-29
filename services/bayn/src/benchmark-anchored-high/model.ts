import { candidateDevelopmentStatisticsPolicy, type CandidateDevelopmentPreflightPass } from '../candidate-development'
import { defaultExecutionModel } from '../execution-model'
import type { CanonicalHashFailure } from '../hash'
import type { AlignedSession, SimulationFailure, SimulationTarget } from '../simulation'
import type { EconomicVerdict, IsoDate, PerformanceMetrics, SimulationProtocol } from '../types'

export const CANDIDATE_10_ORDINAL = 10 as const
export const CANDIDATE_10_STRATEGY_NAME = 'benchmark-anchored-52-week-high-rotation' as const
export const CANDIDATE_10_STRATEGY_VERSION = '1.0.0' as const
export const CANDIDATE_10_DEVELOPMENT_START = '2016-01-04' as const
export const CANDIDATE_10_DEVELOPMENT_END = '2022-12-30' as const
export const CANDIDATE_10_HOLDOUT_START = '2023-01-03' as const
export const CANDIDATE_10_HOLDOUT_END = '2025-12-31' as const
export const CANDIDATE_10_SNAPSHOT_ID = '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0'
export const CANDIDATE_10_PREREGISTRATION_SHA256 = '40e00e6aed866e3576774ccf3125d7dea1f7a5ce7f5e15454c5caf58f96af87b'
export const CANDIDATE_10_PREREGISTRATION_COMMIT = '6530542d246047c7cfc6ef62f4ac1996feb5524d'

export const candidate10Universe = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const
export type Candidate10Symbol = (typeof candidate10Universe)[number]

export const candidate10Specifications = [
  { id: 'high-proximity-h000', hurdle: 0 },
  { id: 'high-proximity-h010', hurdle: 0.01 },
  { id: 'high-proximity-h020', hurdle: 0.02 },
] as const
export type Candidate10Specification = (typeof candidate10Specifications)[number]
export type Candidate10SpecificationId = Candidate10Specification['id']

export const candidate10SelectionMultiplicity = candidate10Specifications.length
export const candidate10DevelopmentStatisticsPolicy = candidateDevelopmentStatisticsPolicy

export const candidate10Protocol = {
  schemaVersion: 'bayn.benchmark-anchored-52-week-high.protocol.v1',
  candidateOrdinal: CANDIDATE_10_ORDINAL,
  strategyName: CANDIDATE_10_STRATEGY_NAME,
  strategyVersion: CANDIDATE_10_STRATEGY_VERSION,
  universe: candidate10Universe,
  feature: {
    name: 'trailing-high-proximity' as const,
    sessions: 252,
    price: 'all-adjusted-finalized-close' as const,
  },
  allocation: {
    anchor: 'SPY' as const,
    challengerTieBreak: 'ascending-symbol' as const,
    grossExposure: 1,
    positionCount: 1,
  },
  schedule: {
    signal: 'canonical-official-month-end-finalized-close' as const,
    execution: 'next-official-session-open' as const,
    terminalSignalDate: '2022-12-29' as const,
    terminalExecutionDate: CANDIDATE_10_DEVELOPMENT_END,
  },
  selection: {
    specifications: candidate10Specifications,
    maximumSpecifications: candidate10Specifications.length,
    precedingAttempts: 9,
    familyOneSidedAlpha: candidate10DevelopmentStatisticsPolicy.confidence.familyOneSidedAlpha,
    selectionMultiplicity: candidate10SelectionMultiplicity,
    order: [
      'annualized-excess-return-lower-bound-descending',
      'sharpe-difference-lower-bound-descending',
      'annual-turnover-ascending',
      'specification-id-ascending',
    ] as const,
  },
} as const

export const candidate10SimulationProtocol: SimulationProtocol = {
  universe: candidate10Protocol.universe,
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

export const candidate10PriorAttemptIds = [
  'b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7',
  '87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f',
  '7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32',
  '440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861',
  'a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217',
  '300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47',
  '8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be',
  '36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c',
  '8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc',
].toSorted()

export const candidate10BehaviorMaterial = {
  schemaVersion: 'bayn.benchmark-anchored-52-week-high.behavior.v1',
  feature: 'signal-close-divided-by-maximum-trailing-252-adjusted-closes',
  challenger: 'greatest-non-spy-high-proximity-with-ascending-symbol-tie-break',
  allocation: 'one-hundred-percent-challenger-only-when-score-exceeds-spy-plus-frozen-hurdle-otherwise-spy',
  schedule: 'official-month-end-finalized-close-to-next-session-open',
  universe: 'DBC-EFA-IEF-SPY-VNQ-long-only-fully-invested-single-asset',
  missingData: 'fail-closed-no-imputation',
  terminal: '2022-12-29-finalized-close-to-2022-12-30-open-all-cash',
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

export const candidate10DevelopmentSessions = (): readonly IsoDate[] => {
  const sessions: IsoDate[] = []
  for (
    let date = new Date(`${CANDIDATE_10_DEVELOPMENT_START}T00:00:00.000Z`);
    date <= new Date(`${CANDIDATE_10_DEVELOPMENT_END}T00:00:00.000Z`);
    date = new Date(date.getTime() + 86_400_000)
  ) {
    const session = date.toISOString().slice(0, 10) as IsoDate
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !fullMarketClosures.has(session)) sessions.push(session)
  }
  return sessions
}

export interface Candidate10Bar {
  readonly symbol: Candidate10Symbol
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface Candidate10Dataset {
  readonly snapshotId: string
  readonly sessions: readonly IsoDate[]
  readonly bars: readonly Candidate10Bar[]
  readonly sessionsContentHash: string
  readonly barsContentHash: string
}

export interface Candidate10Registration {
  readonly preregistrationHash: string
  readonly preregistrationCommit: typeof CANDIDATE_10_PREREGISTRATION_COMMIT
  readonly evaluatedCommit: string
}

export interface Candidate10Plan {
  readonly specification: Candidate10Specification
  readonly targets: readonly SimulationTarget[]
  readonly rebalanceExecutionDates: readonly IsoDate[]
  readonly simulationStartIndex: number
  readonly evaluationStartIndex: number
}

export interface Candidate10UncertaintyEvidence {
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

export interface Candidate10SpecificationReport {
  readonly specification: Candidate10Specification
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
  readonly uncertainty: Candidate10UncertaintyEvidence
  readonly developmentPass: boolean
}

export interface Candidate10DevelopmentReport {
  readonly schemaVersion: 'bayn.candidate-10-development-report.v1'
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly evaluatedCommit: string
  readonly preregistrationHash: string
  readonly preregistrationCommit: typeof CANDIDATE_10_PREREGISTRATION_COMMIT
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
    readonly selectedSpecificationId: Candidate10SpecificationId | null
  }
  readonly specifications: readonly Candidate10SpecificationReport[]
  readonly holdout: {
    readonly start: typeof CANDIDATE_10_HOLDOUT_START
    readonly end: typeof CANDIDATE_10_HOLDOUT_END
    readonly inspected: false
    readonly accessCount: 0
  }
}

export type Candidate10Failure =
  | { readonly _tag: 'Candidate10InvalidInput'; readonly operation: string; readonly reason: string }
  | { readonly _tag: 'Candidate10HashFailure'; readonly operation: string; readonly cause: CanonicalHashFailure }
  | { readonly _tag: 'Candidate10SimulationFailure'; readonly simulation: string; readonly cause: SimulationFailure }
  | { readonly _tag: 'Candidate10QualificationFailure'; readonly cause: unknown }
  | { readonly _tag: 'Candidate10IoFailure'; readonly operation: string; readonly cause: unknown }

export interface Candidate10PreparedData {
  readonly dataset: Candidate10Dataset
  readonly sessions: readonly AlignedSession[]
}
