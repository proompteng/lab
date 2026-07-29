import { candidateDevelopmentStatisticsPolicy, type CandidateDevelopmentPreflightPass } from '../candidate-development'
import { defaultExecutionModel } from '../execution-model'
import type { CanonicalHashFailure } from '../hash'
import type { AlignedSession, SimulationFailure, SimulationTarget } from '../simulation'
import type { EconomicVerdict, IsoDate, PerformanceMetrics, SimulationProtocol } from '../types'

export const CANDIDATE_11_ORDINAL = 11 as const
export const CANDIDATE_11_STRATEGY_NAME = 'benchmark-anchored-abnormal-volume-continuation' as const
export const CANDIDATE_11_STRATEGY_VERSION = '1.0.0' as const
export const CANDIDATE_11_DEVELOPMENT_START = '2016-01-04' as const
export const CANDIDATE_11_DEVELOPMENT_END = '2022-12-30' as const
export const CANDIDATE_11_HOLDOUT_START = '2023-01-03' as const
export const CANDIDATE_11_HOLDOUT_END = '2025-12-31' as const
export const CANDIDATE_11_SNAPSHOT_ID = '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0'
export const CANDIDATE_11_PREREGISTRATION_SHA256 = 'c3b149a90ea99dcd28e7a2a94e991dd30a4b5d8e4fef721ea9ad50a07cfc243d'
export const CANDIDATE_11_PREREGISTRATION_COMMIT = 'e0b412c55c54a4a9607f1b8db0ba3ee08b5d35c8'

export const candidate11Universe = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const
export type Candidate11Symbol = (typeof candidate11Universe)[number]

export const candidate11Specifications = [
  {
    id: 'attention-volume-v125-s050',
    featureSessions: 63,
    recentDollarVolumeSessions: 5,
    baselineDollarVolumeSessions: 58,
    relativeReturnSessions: 21,
    abnormalDollarVolumeThreshold: 1.25,
    spyWeight: 0.5,
    challengerWeight: 0.5,
  },
] as const
export type Candidate11Specification = (typeof candidate11Specifications)[number]
export type Candidate11SpecificationId = Candidate11Specification['id']

export const candidate11SelectionMultiplicity = candidate11Specifications.length
export const candidate11DevelopmentStatisticsPolicy = candidateDevelopmentStatisticsPolicy

export const candidate11Protocol = {
  schemaVersion: 'bayn.benchmark-anchored-abnormal-volume-continuation.protocol.v1',
  candidateOrdinal: CANDIDATE_11_ORDINAL,
  strategyName: CANDIDATE_11_STRATEGY_NAME,
  strategyVersion: CANDIDATE_11_STRATEGY_VERSION,
  universe: candidate11Universe,
  feature: {
    name: 'abnormal-dollar-volume-with-positive-relative-return' as const,
    sessions: 63,
    recentDollarVolumeSessions: 5,
    baselineDollarVolumeSessions: 58,
    relativeReturnSessions: 21,
    abnormalDollarVolumeThreshold: 1.25,
    price: 'all-adjusted-finalized-close' as const,
    volume: 'all-adjusted-finalized-volume' as const,
  },
  allocation: {
    anchor: 'SPY' as const,
    challengerSelection: 'abnormal-dollar-volume-descending' as const,
    challengerTieBreak: ['relative-return-descending', 'ascending-symbol'] as const,
    anchorWeight: 0.5,
    challengerWeight: 0.5,
    fallbackAnchorWeight: 1,
    grossExposure: 1,
    maximumPositionCount: 2,
  },
  schedule: {
    signal: 'canonical-official-month-end-finalized-close' as const,
    execution: 'next-official-session-open' as const,
    terminalSignalDate: '2022-12-29' as const,
    terminalExecutionDate: CANDIDATE_11_DEVELOPMENT_END,
  },
  selection: {
    specifications: candidate11Specifications,
    maximumSpecifications: candidate11Specifications.length,
    precedingAttempts: 10,
    familyOneSidedAlpha: candidate11DevelopmentStatisticsPolicy.confidence.familyOneSidedAlpha,
    selectionMultiplicity: candidate11SelectionMultiplicity,
    order: ['sole-specification-must-pass-all-gates'] as const,
  },
} as const

export const candidate11SimulationProtocol: SimulationProtocol = {
  universe: candidate11Protocol.universe,
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

export const candidate11PriorAttemptIds = [
  'b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7',
  '87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f',
  '7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32',
  '440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861',
  'a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217',
  '300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47',
  '8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be',
  '36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c',
  '8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc',
  'bf19a5d8b29032146effeadca2bf129924c9062dd5b516a0483927207c333cfc',
].toSorted()

export const candidate11BehaviorMaterial = {
  schemaVersion: 'bayn.benchmark-anchored-abnormal-volume-continuation.behavior.v1',
  feature:
    'five-session-average-adjusted-dollar-volume-divided-by-prior-fifty-eight-session-average-adjusted-dollar-volume',
  direction: 'twenty-one-session-symbol-return-minus-contemporaneous-SPY-return-must-be-strictly-positive',
  eligibility: 'non-SPY-abnormal-dollar-volume-at-least-one-point-two-five-and-positive-relative-return',
  challenger:
    'greatest-abnormal-dollar-volume-then-greatest-relative-return-then-ascending-symbol-among-eligible-non-SPY-assets',
  allocation: 'fifty-percent-SPY-and-fifty-percent-challenger-otherwise-one-hundred-percent-SPY',
  schedule: 'official-month-end-finalized-close-to-next-session-open',
  universe: 'DBC-EFA-IEF-SPY-VNQ-long-only-unlevered-fully-invested',
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

export const candidate11DevelopmentSessions = (): readonly IsoDate[] => {
  const sessions: IsoDate[] = []
  for (
    let date = new Date(`${CANDIDATE_11_DEVELOPMENT_START}T00:00:00.000Z`);
    date <= new Date(`${CANDIDATE_11_DEVELOPMENT_END}T00:00:00.000Z`);
    date = new Date(date.getTime() + 86_400_000)
  ) {
    const session = date.toISOString().slice(0, 10) as IsoDate
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !fullMarketClosures.has(session)) sessions.push(session)
  }
  return sessions
}

export interface Candidate11Bar {
  readonly symbol: Candidate11Symbol
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface Candidate11Dataset {
  readonly snapshotId: string
  readonly sessions: readonly IsoDate[]
  readonly bars: readonly Candidate11Bar[]
  readonly sessionsContentHash: string
  readonly barsContentHash: string
}

export interface Candidate11Registration {
  readonly preregistrationHash: string
  readonly preregistrationCommit: typeof CANDIDATE_11_PREREGISTRATION_COMMIT
  readonly evaluatedCommit: string
}

export interface Candidate11Plan {
  readonly specification: Candidate11Specification
  readonly targets: readonly SimulationTarget[]
  readonly rebalanceExecutionDates: readonly IsoDate[]
  readonly simulationStartIndex: number
  readonly evaluationStartIndex: number
}

export interface Candidate11UncertaintyEvidence {
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

export interface Candidate11SpecificationReport {
  readonly specification: Candidate11Specification
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
  readonly uncertainty: Candidate11UncertaintyEvidence
  readonly developmentPass: boolean
}

export interface Candidate11DevelopmentReport {
  readonly schemaVersion: 'bayn.candidate-11-development-report.v1'
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly evaluatedCommit: string
  readonly preregistrationHash: string
  readonly preregistrationCommit: typeof CANDIDATE_11_PREREGISTRATION_COMMIT
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
    readonly selectedSpecificationId: Candidate11SpecificationId | null
  }
  readonly specifications: readonly Candidate11SpecificationReport[]
  readonly holdout: {
    readonly start: typeof CANDIDATE_11_HOLDOUT_START
    readonly end: typeof CANDIDATE_11_HOLDOUT_END
    readonly inspected: false
    readonly accessCount: 0
  }
}

export type Candidate11Failure =
  | { readonly _tag: 'Candidate11InvalidInput'; readonly operation: string; readonly reason: string }
  | { readonly _tag: 'Candidate11HashFailure'; readonly operation: string; readonly cause: CanonicalHashFailure }
  | { readonly _tag: 'Candidate11SimulationFailure'; readonly simulation: string; readonly cause: SimulationFailure }
  | { readonly _tag: 'Candidate11QualificationFailure'; readonly cause: unknown }
  | { readonly _tag: 'Candidate11IoFailure'; readonly operation: string; readonly cause: unknown }

export interface Candidate11PreparedData {
  readonly dataset: Candidate11Dataset
  readonly sessions: readonly AlignedSession[]
}
