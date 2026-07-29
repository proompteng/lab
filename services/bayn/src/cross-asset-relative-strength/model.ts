import type { DailyBar, IsoDate, PerformanceMetrics, SimulationProtocol } from '../types'

export const CANDIDATE_7_ORDINAL = 7 as const
export const CANDIDATE_7_STRATEGY_NAME = 'cross-asset-relative-strength' as const
export const CANDIDATE_7_SCHEMA_VERSION = 'bayn.cross-asset-relative-strength.v1' as const
export const CANDIDATE_7_UNIVERSE = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const
export type Candidate7Symbol = (typeof CANDIDATE_7_UNIVERSE)[number]

export const CANDIDATE_7_HISTORY_START = '2016-01-04' as IsoDate
export const CANDIDATE_7_EVALUATION_START = '2017-01-03' as IsoDate
export const CANDIDATE_7_DEVELOPMENT_END = '2022-12-30' as IsoDate
export const CANDIDATE_7_TERMINAL_SIGNAL = '2022-12-29' as IsoDate
export const CANDIDATE_7_HOLDOUT_START = '2023-01-03' as IsoDate

export const candidate7DatasetIdentity = {
  snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
  publicationAsOf: '2026-07-27',
  calendarVersion: 'alpaca-us-equity-calendar-v1',
  universeId: 'cross-asset-taa-v1',
  universeSymbolHash: 'c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8',
  manifestContentHash: '7b1216c8d698da4b2e74a5a77584c9863608edab0ad1c7331f37d039ddb1a764',
  rawManifestExportSha256: '79400b64fcd981fc87874fbc0fd647033cfe8acadd1abb2f6a3f0af092699e43',
  rawBarsExportSha256: 'c71ba30f3bcdd373708636f7c799d6caf3e24e07fd7d428522c69167c11a0c9c',
  rawSessionsExportSha256: 'd0f182b5436c3ce374f4afaf2735c4b66247edfb78378aeff42af1efc889aabf',
  boundedBarsContentHash: '9fac08a198bac2dea6530e12a4406c695c84da8829b9a198f26511c822164785',
  boundedSessionsContentHash: '8fb5cf8accec311c6d34dd5d1074b9ac2cee38c51eaf906df26fd3479f48e358',
  officialSessionCount: 1_762,
} as const

export const candidate7Protocol = {
  schemaVersion: CANDIDATE_7_SCHEMA_VERSION,
  candidateOrdinal: CANDIDATE_7_ORDINAL,
  strategyName: CANDIDATE_7_STRATEGY_NAME,
  universeId: candidate7DatasetIdentity.universeId,
  universeSymbolHash: candidate7DatasetIdentity.universeSymbolHash,
  universe: CANDIDATE_7_UNIVERSE,
  historyStart: CANDIDATE_7_HISTORY_START,
  evaluationStart: CANDIDATE_7_EVALUATION_START,
  developmentEnd: CANDIDATE_7_DEVELOPMENT_END,
  holdoutStart: CANDIDATE_7_HOLDOUT_START,
  signal: {
    lookbackSessions: 252,
    skipRecentSessions: 21,
    selectedAssetCount: 2,
    requirePositiveScore: true,
    rebalance: 'month-end',
    tieBreak: 'symbol-ascending',
  },
  risk: {
    covarianceWindowSessions: 63,
    annualizationSessions: 252,
    targetAnnualizedVolatility: 0.1,
    maximumSymbolWeight: 0.5,
    maximumGrossExposure: 1,
    leverageAllowed: false,
    shortingAllowed: false,
  },
  terminal: {
    signalDate: CANDIDATE_7_TERMINAL_SIGNAL,
    executionDate: CANDIDATE_7_DEVELOPMENT_END,
    target: 'cash',
  },
} as const

export interface Candidate7DevelopmentSession {
  readonly snapshotId: string
  readonly calendarVersion: string
  readonly sessionDate: IsoDate
  readonly openTime: string
  readonly closeTime: string
  readonly timezone: string
  readonly provider: string
}

export interface Candidate7DevelopmentDataset {
  readonly snapshotId: string
  readonly publicationAsOf: IsoDate
  readonly calendarVersion: string
  readonly manifestContentHash: string
  readonly rawManifestExportSha256: string
  readonly rawBarsExportSha256: string
  readonly rawSessionsExportSha256: string
  readonly boundedBarsContentHash: string
  readonly boundedSessionsContentHash: string
  readonly sessions: readonly Candidate7DevelopmentSession[]
  readonly bars: readonly DailyBar[]
}

export interface Candidate7Signal {
  readonly symbol: Candidate7Symbol
  readonly score: number
  readonly rank: number
  readonly selected: boolean
  readonly targetWeight: number
}

export interface Candidate7Decision {
  readonly signalDate: IsoDate
  readonly executionDate: IsoDate
  readonly covarianceStart: IsoDate
  readonly covarianceEnd: IsoDate
  readonly estimatedAnnualizedVolatility: number
  readonly exposureScale: number
  readonly signals: readonly Candidate7Signal[]
  readonly targetWeights: Readonly<Record<Candidate7Symbol, number>>
}

export type Candidate7Failure =
  | {
      readonly _tag: 'Candidate7DatasetMismatch'
      readonly field: string
      readonly expected: unknown
      readonly observed: unknown
    }
  | { readonly _tag: 'Candidate7InvalidSession'; readonly reason: string; readonly sessionDate?: IsoDate }
  | {
      readonly _tag: 'Candidate7InvalidBar'
      readonly reason: string
      readonly symbol?: string
      readonly sessionDate?: IsoDate
    }
  | { readonly _tag: 'Candidate7MissingBar'; readonly symbol: Candidate7Symbol; readonly sessionDate: IsoDate }
  | { readonly _tag: 'Candidate7InvalidSignal'; readonly reason: string; readonly signalIndex: number }
  | { readonly _tag: 'Candidate7HashFailure'; readonly operation: string; readonly cause: unknown }
  | { readonly _tag: 'Candidate7SimulationFailure'; readonly simulation: string; readonly cause: unknown }
  | { readonly _tag: 'Candidate7QualificationFailure'; readonly cause: unknown }

export interface Candidate7DevelopmentReportMaterial {
  readonly schemaVersion: 'bayn.candidate-7-development-report.v1'
  readonly candidateOrdinal: 7
  readonly strategyName: typeof CANDIDATE_7_STRATEGY_NAME
  readonly evaluatedCommit: string
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly identity: {
    readonly parameterHash: string
    readonly behaviorHash: string
    readonly strategyHash: string
    readonly runId: string
  }
  readonly dataset: {
    readonly snapshotId: string
    readonly publicationAsOf: IsoDate
    readonly firstSession: IsoDate
    readonly lastSession: IsoDate
    readonly sessionCount: number
    readonly barCount: number
    readonly boundedBarsContentHash: string
    readonly boundedSessionsContentHash: string
  }
  readonly metrics: {
    readonly strategy: PerformanceMetrics
    readonly buyAndHold: PerformanceMetrics
    readonly directVolatility: PerformanceMetrics
    readonly doubleCostStrategy: PerformanceMetrics
  }
  readonly selectedBenchmark: {
    readonly name: 'buy-and-hold' | 'direct-volatility-timing'
    readonly sharpe: number
    readonly strategySharpeDifference: number
  }
  readonly economicGates: readonly {
    readonly name: string
    readonly passed: boolean
    readonly actual: boolean | number | string
    readonly required: boolean | number | string
  }[]
  readonly uncertainty: {
    readonly status: 'PASS' | 'REJECTED' | 'INSUFFICIENT'
    readonly reasonCodes: readonly string[]
    readonly adjustedOneSidedAlpha: number
    readonly annualizedExcessReturnLowerBound: number
    readonly sharpeDifferenceLowerBound: number
    readonly completeRebalanceBlocks: number
    readonly requiredCompleteRebalanceBlocks: number
    readonly availableCompleteSessions: number
    readonly requiredSessions: number
    readonly walkForwardFolds: number
    readonly requiredWalkForwardFolds: number
    readonly positiveWalkForwardFolds: number
    readonly analysisHash: string
  }
  readonly holdout: {
    readonly start: typeof CANDIDATE_7_HOLDOUT_START
    readonly inspected: false
  }
  readonly recommendation: 'RETAIN_RESEARCH_ONLY_AWAIT_APPROVAL' | 'REMOVE_IMPLEMENTATION_CLOSE_WITHOUT_MERGE'
}

export interface Candidate7DevelopmentReport extends Candidate7DevelopmentReportMaterial {
  readonly reportHash: string
}

export type Candidate7SimulationProtocol = SimulationProtocol
