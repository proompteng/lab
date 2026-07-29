import { defaultExecutionModel } from '../execution-model'
import type { CandidateDevelopmentPreflightPass } from '../candidate-development'
import type { CanonicalHashFailure } from '../hash'
import type { AlignedSession, SimulationFailure } from '../simulation'
import type { EconomicVerdict, IsoDate, PerformanceMetrics, SimulationProtocol } from '../types'

export const CANDIDATE_9_ORDINAL = 9 as const
export const CANDIDATE_9_STRATEGY_NAME = 'asymmetric-range-volatility-managed-equity' as const
export const CANDIDATE_9_STRATEGY_VERSION = '1.0.0' as const
export const CANDIDATE_9_SYMBOL = 'SPY' as const
export const CANDIDATE_9_DEVELOPMENT_START = '2016-01-04' as const
export const CANDIDATE_9_DEVELOPMENT_END = '2022-12-30' as const
export const CANDIDATE_9_HOLDOUT_START = '2023-01-03' as const
export const CANDIDATE_9_HOLDOUT_END = '2025-12-31' as const
export const CANDIDATE_9_SNAPSHOT_ID = '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0'
export const CANDIDATE_9_PREREGISTRATION_SHA256 = '6a8029d7638eecdd103bb8d0ee558772ff8797e72b93c1371947c28836e508c4'

export const candidate9Protocol = {
  schemaVersion: 'bayn.asymmetric-range-volatility.protocol.v1',
  candidateOrdinal: CANDIDATE_9_ORDINAL,
  strategyName: CANDIDATE_9_STRATEGY_NAME,
  strategyVersion: CANDIDATE_9_STRATEGY_VERSION,
  universe: [CANDIDATE_9_SYMBOL] as const,
  feature: {
    rangeEstimator: 'parkinson' as const,
    sessions: 21,
    negativeSemivarianceMultiplier: 2,
    annualizationSessions: 252,
  },
  allocation: {
    targetAnnualizedVariance: 0.1 ** 2,
    maximumWeight: 1,
    roundingDecimals: 12,
  },
  schedule: {
    signal: 'canonical-official-month-end-finalized-close' as const,
    execution: 'next-official-session-open' as const,
    terminalSignalDate: '2022-12-29' as const,
    terminalExecutionDate: CANDIDATE_9_DEVELOPMENT_END,
  },
  selection: {
    maximumSpecifications: 1,
    precedingAttempts: 8,
    familyOneSidedAlpha: 0.05,
  },
} as const

export const candidate9SimulationProtocol: SimulationProtocol = {
  universe: candidate9Protocol.universe,
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

export const candidate9PriorAttemptIds = [
  'b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7',
  '87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f',
  '7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32',
  '440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861',
  'a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217',
  '300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47',
  '8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be',
  '36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c',
].toSorted()

export const candidate9BehaviorMaterial = {
  schemaVersion: 'bayn.asymmetric-range-volatility.behavior.v1',
  feature: 'mean-21-session-parkinson-range-variance-plus-two-times-negative-close-semivariance',
  allocation: 'ten-percent-target-daily-variance-divided-by-forecast-variance-capped-one',
  schedule: 'official-month-end-finalized-close-to-next-session-open',
  universe: 'SPY-long-or-cash-no-leverage',
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

export const candidate9DevelopmentSessions = (): readonly IsoDate[] => {
  const sessions: IsoDate[] = []
  for (
    let date = new Date(`${CANDIDATE_9_DEVELOPMENT_START}T00:00:00.000Z`);
    date <= new Date(`${CANDIDATE_9_DEVELOPMENT_END}T00:00:00.000Z`);
    date = new Date(date.getTime() + 86_400_000)
  ) {
    const session = date.toISOString().slice(0, 10) as IsoDate
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !fullMarketClosures.has(session)) sessions.push(session)
  }
  return sessions
}

export interface Candidate9Bar {
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface Candidate9Dataset {
  readonly snapshotId: string
  readonly sessions: readonly IsoDate[]
  readonly bars: readonly Candidate9Bar[]
  readonly sessionsContentHash: string
  readonly barsContentHash: string
}

export interface Candidate9Registration {
  readonly preregistrationHash: string
  readonly evaluatedCommit: string
}

export interface Candidate9Plan {
  readonly targets: readonly import('../simulation').SimulationTarget[]
  readonly rebalanceExecutionDates: readonly IsoDate[]
  readonly startIndex: number
}

export interface Candidate9DevelopmentReport {
  readonly schemaVersion: 'bayn.candidate-9-development-report.v1'
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly evaluatedCommit: string
  readonly preregistrationHash: string
  readonly identity: {
    readonly parameterHash: string
    readonly behaviorHash: string
    readonly strategyHash: string
    readonly runId: string
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
  readonly uncertainty: {
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
  readonly holdout: {
    readonly start: typeof CANDIDATE_9_HOLDOUT_START
    readonly end: typeof CANDIDATE_9_HOLDOUT_END
    readonly inspected: false
    readonly accessCount: 0
  }
}

export type Candidate9Failure =
  | { readonly _tag: 'Candidate9InvalidInput'; readonly operation: string; readonly reason: string }
  | { readonly _tag: 'Candidate9HashFailure'; readonly operation: string; readonly cause: CanonicalHashFailure }
  | { readonly _tag: 'Candidate9SimulationFailure'; readonly simulation: string; readonly cause: SimulationFailure }
  | { readonly _tag: 'Candidate9QualificationFailure'; readonly cause: unknown }
  | { readonly _tag: 'Candidate9IoFailure'; readonly operation: string; readonly cause: unknown }

export interface Candidate9PreparedData {
  readonly dataset: Candidate9Dataset
  readonly sessions: readonly AlignedSession[]
}
