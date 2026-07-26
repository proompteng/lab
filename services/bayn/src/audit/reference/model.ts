import type { Result } from 'effect'

import type { ContractConstructionFailure } from '../../contracts'
import type { ExecutionModelFailure } from '../../execution-model'
import type { CanonicalHashFailure } from '../../hash'
import type {
  DailyBar,
  DailyPerformancePoint,
  DecisionPlan,
  EconomicVerdict,
  EvaluationEvent,
  IsoDate,
  PerformanceMetrics,
  SignalDecision,
  SimulationTrace,
} from '../../types'

export interface Session {
  readonly date: IsoDate
  readonly bars: Readonly<Record<string, DailyBar>>
}

export interface Target {
  readonly signalIndex: number
  readonly executionIndex: number
  readonly weights: Readonly<Record<string, number>>
  readonly plan?: DecisionPlan
}

export interface Position {
  readonly quantityMicros: bigint
  readonly costBasisMicros: bigint
}

export interface ReferenceReplayWork {
  readonly sessionsProcessed: number
  readonly positionStateCopies: number
  readonly positionWrites: number
}

export interface Replay {
  readonly metrics: PerformanceMetrics
  readonly events: readonly EvaluationEvent[]
  readonly decisions: readonly SignalDecision[]
  readonly daily: readonly DailyPerformancePoint[]
  readonly trace: SimulationTrace | null
}

export interface ReplayWithWork extends Replay {
  readonly work: ReferenceReplayWork
}

export interface ReferenceEvaluation {
  readonly runId: string
  readonly protocolHash: string
  readonly strategy: Replay
  readonly buyAndHold: Replay
  readonly directVolTiming: Replay
  readonly doubleCostStrategy: Replay
  readonly verdict: EconomicVerdict
}

export interface ReferenceEvaluationWork {
  readonly strategy: ReferenceReplayWork
  readonly buyAndHold: ReferenceReplayWork
  readonly directVolTiming: ReferenceReplayWork
  readonly doubleCostStrategy: ReferenceReplayWork
}

export interface ReferenceEvaluationWithWork {
  readonly runId: string
  readonly protocolHash: string
  readonly strategy: ReplayWithWork
  readonly buyAndHold: ReplayWithWork
  readonly directVolTiming: ReplayWithWork
  readonly doubleCostStrategy: ReplayWithWork
  readonly verdict: EconomicVerdict
}

export type ReferenceEvaluationFailure =
  | ExecutionModelFailure
  | ContractConstructionFailure
  | CanonicalHashFailure
  | {
      readonly _tag: 'UnsupportedReferenceExecutionModel'
      readonly actual: string
      readonly required: 'bayn.execution-model.v2'
    }
  | {
      readonly _tag: 'ReferenceInputRowCountMismatch'
      readonly expected: number
      readonly actual: number
    }
  | {
      readonly _tag: 'ReferenceUnexpectedSymbol'
      readonly symbol: string
      readonly sessionDate: IsoDate
      readonly universe: readonly string[]
    }
  | {
      readonly _tag: 'ReferenceDuplicateBar'
      readonly symbol: string
      readonly sessionDate: IsoDate
    }
  | {
      readonly _tag: 'ReferenceIncompleteSession'
      readonly sessionDate: IsoDate
      readonly missingSymbols: readonly string[]
      readonly actualSymbolCount: number
      readonly expectedSymbolCount: number
    }
  | {
      readonly _tag: 'ReferenceManifestSessionMismatch'
      readonly expectedSessionCount: number
      readonly actualSessionCount: number
      readonly expectedFirstSession: IsoDate
      readonly actualFirstSession: IsoDate | null
      readonly expectedLastSession: IsoDate
      readonly actualLastSession: IsoDate | null
    }
  | {
      readonly _tag: 'ReferenceInvalidWeight'
      readonly symbol: string
      readonly weight: number
      readonly maximumWeight: number
    }
  | {
      readonly _tag: 'ReferenceWeightBoundingFailed'
      readonly totalUnits: number
      readonly excessUnits: number
      readonly weightScale: number
    }
  | {
      readonly _tag: 'ReferenceCovarianceInputMismatch'
      readonly leftLength: number
      readonly rightLength: number
    }
  | {
      readonly _tag: 'ReferenceCovarianceNotFinite'
      readonly leftLength: number
      readonly rightLength: number
      readonly covariance: number
    }
  | {
      readonly _tag: 'ReferencePortfolioVarianceInvalid'
      readonly dailyVariance: number
    }
  | {
      readonly _tag: 'ReferencePortfolioVolatilityInvalid'
      readonly dailyVariance: number
      readonly annualizedVolatility: number
    }
  | {
      readonly _tag: 'ReferenceInsufficientHistory'
      readonly signalIndex: number
      readonly requiredHistory: number
      readonly sessionCount: number
    }
  | {
      readonly _tag: 'ReferenceInvalidClose'
      readonly symbol: string
      readonly sessionDate: IsoDate
      readonly close: number
    }
  | {
      readonly _tag: 'ReferenceMissingCurrentClose'
      readonly symbol: string
      readonly signalIndex: number
    }
  | {
      readonly _tag: 'ReferenceInvalidReturn'
      readonly symbol: string
      readonly sessionDate: IsoDate
      readonly value: number
    }
  | {
      readonly _tag: 'ReferenceMissingPriorClose'
      readonly symbol: string
      readonly signalIndex: number
      readonly horizonSessions: number
    }
  | {
      readonly _tag: 'ReferenceInvalidHorizonSignal'
      readonly symbol: string
      readonly horizonSessions: number
      readonly return: number
      readonly normalizedTrend: number
    }
  | {
      readonly _tag: 'ReferenceInvalidScore'
      readonly symbol: string
      readonly annualizedVolatility: number
      readonly compositeScore: number
    }
  | {
      readonly _tag: 'ReferenceWeightsOutsideLimits'
      readonly totalWeight: number
      readonly maximumSymbolWeight: number
      readonly portfolioVolatility: number
      readonly maximumPortfolioVolatility: number
    }
  | {
      readonly _tag: 'ReferenceDirectVolatilityWindowInvalid'
      readonly signalIndex: number
      readonly requiredPriorIndex: number
      readonly sessionCount: number
    }
  | {
      readonly _tag: 'ReferenceInvalidEquityCurve'
      readonly observationCount: number
      readonly firstNonPositiveIndex: number | null
      readonly firstNonPositiveValueMicros: string | null
    }
  | {
      readonly _tag: 'ReferenceBuyFillRestrictionInvalid'
      readonly orderId: string
      readonly modeledQuantityMicros: string
      readonly permittedQuantityMicros: string
    }
  | {
      readonly _tag: 'ReferenceMissingDecisionPlan'
      readonly signalIndex: number
      readonly executionIndex: number
    }
  | {
      readonly _tag: 'ReferenceTargetSignalMissing'
      readonly signalIndex: number
      readonly executionIndex: number
      readonly sessionCount: number
    }
  | {
      readonly _tag: 'ReferenceNegativeCash'
      readonly sessionDate: IsoDate
      readonly cashMicros: string
    }
  | {
      readonly _tag: 'ReferenceNoEligibleSignal'
      readonly sessionCount: number
      readonly lookbackStart: IsoDate
      readonly evaluationStart: IsoDate
      readonly evaluationEnd: IsoDate
    }
  | {
      readonly _tag: 'ReferenceInsufficientObservations'
      readonly actual: number
      readonly required: number
      readonly startIndex: number
      readonly endExclusive: number
    }
  | {
      readonly _tag: 'ReferenceProvenanceMismatch'
      readonly requiredStrategyName: 'risk-balanced-trend'
      readonly actualStrategyName: string
      readonly expectedParameterHash: string
      readonly actualParameterHash: string
    }

export type ReferenceComputation<A> = Result.Result<A, ReferenceEvaluationFailure>
