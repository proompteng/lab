import type { DailyBar, IsoDate } from '../types'

export const CANDIDATE_6_ORDINAL = 6 as const
export const CANDIDATE_6_STRATEGY_NAME = 'month-end-liquidity-reversal' as const
export const CANDIDATE_6_STRATEGY_VERSION = '1.0.0' as const
export const CANDIDATE_6_SYMBOL = 'SPY' as const

export interface Candidate6Protocol {
  readonly schemaVersion: 'bayn.month-end-liquidity-reversal.protocol.v1'
  readonly candidateOrdinal: 6
  readonly strategyName: typeof CANDIDATE_6_STRATEGY_NAME
  readonly strategyVersion: typeof CANDIDATE_6_STRATEGY_VERSION
  readonly universe: readonly [typeof CANDIDATE_6_SYMBOL]
  readonly marketData: {
    readonly universeId: 'cross-asset-taa-v1'
    readonly source: 'alpaca'
    readonly sourceFeed: 'sip'
    readonly adjustment: 'all'
    readonly publicationSchemaVersion: 'signal.adjusted-daily-snapshot.v2'
    readonly maximumFinalizationLagMilliseconds: number
  }
  readonly signal: {
    readonly pressureLookbackSessions: 5
    readonly signalSessionsBeforeMonthEnd: 4
    readonly entrySessionsBeforeMonthEnd: 3
    readonly exitSessionsAfterMonthEnd: 3
    readonly expectedReversionFraction: 0.5
    readonly calendarExclusions: readonly [
      {
        readonly start: '2024-05-28'
        readonly end: '2024-06-28'
        readonly reason: 'us-equities-t-plus-one-transition'
      },
    ]
  }
  readonly sizing: {
    readonly targetWeight: 0.3
    readonly maximumSymbolWeight: 0.35
    readonly maximumGrossExposure: 0.35
    readonly maximumOneWayTurnover: 1
    readonly liquidityWindowSessions: 20
    readonly minimumAverageDollarVolumeUsd: 100_000_000
    readonly maximumAverageDailyVolumeParticipation: 0.005
  }
  readonly execution: {
    readonly signalPrice: 'finalized-adjusted-close'
    readonly fillPrice: 'next-session-open'
    readonly latencySessions: 1
    readonly halfSpreadBps: 2.5
    readonly slippageBps: 2.5
    readonly costBufferMultiplier: 1.5
    readonly commissionBps: 0
    readonly secSellBps: 0.206
    readonly tafSellPerShareUsd: 0.000195
    readonly tafMaximumPerOrderUsd: 9.79
    readonly catPerShareUsd: 0.000003
    readonly partialFillProbability: 0.1
    readonly partialFillFraction: 0.5
  }
}

export const candidate6Protocol: Candidate6Protocol = {
  schemaVersion: 'bayn.month-end-liquidity-reversal.protocol.v1',
  candidateOrdinal: CANDIDATE_6_ORDINAL,
  strategyName: CANDIDATE_6_STRATEGY_NAME,
  strategyVersion: CANDIDATE_6_STRATEGY_VERSION,
  universe: [CANDIDATE_6_SYMBOL],
  marketData: {
    universeId: 'cross-asset-taa-v1',
    source: 'alpaca',
    sourceFeed: 'sip',
    adjustment: 'all',
    publicationSchemaVersion: 'signal.adjusted-daily-snapshot.v2',
    maximumFinalizationLagMilliseconds: 86_400_000,
  },
  signal: {
    pressureLookbackSessions: 5,
    signalSessionsBeforeMonthEnd: 4,
    entrySessionsBeforeMonthEnd: 3,
    exitSessionsAfterMonthEnd: 3,
    expectedReversionFraction: 0.5,
    calendarExclusions: [
      {
        start: '2024-05-28',
        end: '2024-06-28',
        reason: 'us-equities-t-plus-one-transition',
      },
    ],
  },
  sizing: {
    targetWeight: 0.3,
    maximumSymbolWeight: 0.35,
    maximumGrossExposure: 0.35,
    maximumOneWayTurnover: 1,
    liquidityWindowSessions: 20,
    minimumAverageDollarVolumeUsd: 100_000_000,
    maximumAverageDailyVolumeParticipation: 0.005,
  },
  execution: {
    signalPrice: 'finalized-adjusted-close',
    fillPrice: 'next-session-open',
    latencySessions: 1,
    halfSpreadBps: 2.5,
    slippageBps: 2.5,
    costBufferMultiplier: 1.5,
    commissionBps: 0,
    secSellBps: 0.206,
    tafSellPerShareUsd: 0.000195,
    tafMaximumPerOrderUsd: 9.79,
    catPerShareUsd: 0.000003,
    partialFillProbability: 0.1,
    partialFillFraction: 0.5,
  },
}

export interface Candidate6PositionState {
  readonly activeEntrySignalDate: IsoDate | null
  readonly currentWeights: Readonly<Record<typeof CANDIDATE_6_SYMBOL, number>>
}

export interface Candidate6DecisionInput {
  readonly signalDate: IsoDate
  readonly executionDate: IsoDate
  readonly publicationAsOf: IsoDate
  readonly calendar: readonly IsoDate[]
  readonly bars: readonly DailyBar[]
  readonly position: Candidate6PositionState
  readonly portfolioEquityUsd: number
  readonly finalizedAtEpochMilliseconds: number
  readonly observedAtEpochMilliseconds: number
  readonly protocol?: Candidate6Protocol
}

export interface Candidate6PressureFeature {
  readonly symbol: typeof CANDIDATE_6_SYMBOL
  readonly firstSession: IsoDate
  readonly lastSession: IsoDate
  readonly pressureReturn: number
  readonly expectedGrossReversion: number
  readonly bufferedRoundTripCost: number
  readonly netExpectedReversion: number
  readonly averageDollarVolumeUsd: number
  readonly liquidityWeightCap: number
}

export interface Candidate6OrderIntent {
  readonly symbol: typeof CANDIDATE_6_SYMBOL
  readonly side: 'buy' | 'sell'
  readonly fromWeight: number
  readonly toWeight: number
  readonly weightDelta: number
  readonly maximumNotionalUsd: number
  readonly reason:
    | 'month-end-pressure-entry'
    | 'scheduled-reversal-exit'
    | 'overdue-risk-exit'
    | 'exposure-cap-trim'
    | 'calendar-exclusion-exit'
}

export interface Candidate6Decision {
  readonly schemaVersion: 'bayn.month-end-liquidity-reversal.decision.v1'
  readonly candidateOrdinal: 6
  readonly strategyName: typeof CANDIDATE_6_STRATEGY_NAME
  readonly signalDate: IsoDate
  readonly executionDate: IsoDate
  readonly action: 'enter' | 'exit' | 'hold' | 'cash'
  readonly reason:
    | 'active-hold-window'
    | 'cost-exceeds-expected-reversion'
    | 'entry-signal'
    | 'exposure-cap-trim'
    | 'calendar-exclusion'
    | 'outside-entry-window'
    | 'scheduled-exit'
    | 'overdue-exit'
  readonly targetWeights: Readonly<Record<typeof CANDIDATE_6_SYMBOL, number>>
  readonly feature: Candidate6PressureFeature | null
  readonly orderIntents: readonly Candidate6OrderIntent[]
  readonly constraints: {
    readonly grossExposure: number
    readonly oneWayTurnover: number
    readonly maximumGrossExposure: number
    readonly maximumOneWayTurnover: number
    readonly maximumSymbolWeight: number
  }
}

export type Candidate6DecisionFailure =
  | { readonly _tag: 'InvalidCalendar'; readonly reason: 'duplicate' | 'not-sorted' | 'signal-missing' }
  | { readonly _tag: 'InvalidExecutionSession'; readonly expected: IsoDate | null; readonly observed: IsoDate }
  | { readonly _tag: 'PublicationSessionMismatch'; readonly expected: IsoDate; readonly observed: IsoDate }
  | { readonly _tag: 'InvalidObservationTime'; readonly finalizedAt: number; readonly observedAt: number }
  | { readonly _tag: 'StaleFinalization'; readonly lagMilliseconds: number; readonly maximum: number }
  | { readonly _tag: 'InvalidPortfolioEquity'; readonly portfolioEquityUsd: number }
  | { readonly _tag: 'InvalidCurrentWeight'; readonly weight: number }
  | { readonly _tag: 'UnboundExposure'; readonly weight: number }
  | { readonly _tag: 'UnknownActiveEntry'; readonly activeEntrySignalDate: IsoDate }
  | { readonly _tag: 'FutureBar'; readonly sessionDate: IsoDate; readonly signalDate: IsoDate }
  | { readonly _tag: 'DuplicateBar'; readonly symbol: string; readonly sessionDate: IsoDate }
  | {
      readonly _tag: 'MalformedBar'
      readonly sessionDate: IsoDate
      readonly field: 'open' | 'high' | 'low' | 'close' | 'volume' | 'range'
      readonly value: number
    }
  | { readonly _tag: 'UnexpectedCorporateActionPolicy'; readonly sessionDate: IsoDate; readonly observed: string }
  | { readonly _tag: 'UnexpectedMarketDataSource'; readonly sessionDate: IsoDate; readonly observed: string }
  | { readonly _tag: 'UnexpectedMarketDataFeed'; readonly sessionDate: IsoDate; readonly observed: string }
  | { readonly _tag: 'UnexpectedPublicationSchema'; readonly sessionDate: IsoDate; readonly observed: string }
  | { readonly _tag: 'MissingBar'; readonly sessionDate: IsoDate }
  | { readonly _tag: 'InsufficientHistory'; readonly required: number; readonly observed: number }
  | {
      readonly _tag: 'InsufficientLiquidity'
      readonly averageDollarVolumeUsd: number
      readonly minimumAverageDollarVolumeUsd: number
    }
  | {
      readonly _tag: 'InvalidProtocol'
      readonly field: string
      readonly value: number
    }

export interface Candidate6DevelopmentDataset {
  readonly snapshotId: string
  readonly rawExportSha256: string
  readonly firstSession: IsoDate
  readonly lastSession: IsoDate
  readonly barCount: number
  readonly bars: readonly DailyBar[]
}
