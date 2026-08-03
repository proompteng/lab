import type { Result } from 'effect'

import type { ContractConstructionFailure } from '../contracts'
import type { ExecutionModelFailure } from '../execution-model'
import type { CanonicalJsonFailure } from '../hash'
import type {
  DailyBar,
  DailyPerformancePoint,
  DecisionPlan,
  EvaluationEvent,
  IsoDate,
  PerformanceMetrics,
  SignalDecision,
  SimulatedOrder,
  SimulationProtocol,
  SimulationTrace,
} from '../types'

export type SimulationDomainFailure =
  | {
      readonly _tag: 'InvalidMonetaryValue'
      readonly operation: 'number-to-micros'
      readonly value: number
      readonly reason: 'negative' | 'not-finite'
    }
  | {
      readonly _tag: 'InvalidMicrosString'
      readonly field: 'initialCapitalMicros' | 'minimumBuyNotionalMicros'
      readonly value: string
    }
  | {
      readonly _tag: 'ManifestRowCountMismatch'
      readonly expected: number
      readonly observed: number
    }
  | {
      readonly _tag: 'UnexpectedBarSymbol'
      readonly symbol: string
      readonly universe: readonly string[]
    }
  | {
      readonly _tag: 'DuplicateBar'
      readonly symbol: string
      readonly sessionDate: IsoDate
    }
  | {
      readonly _tag: 'ManifestSessionCountMismatch'
      readonly expected: number
      readonly observed: number
    }
  | {
      readonly _tag: 'IncompleteSession'
      readonly sessionDate: IsoDate
      readonly expectedSymbols: readonly string[]
      readonly observedSymbols: readonly string[]
    }
  | {
      readonly _tag: 'ManifestSessionBoundsMismatch'
      readonly expectedFirst: IsoDate
      readonly observedFirst: IsoDate | null
      readonly expectedLast: IsoDate
      readonly observedLast: IsoDate | null
    }
  | {
      readonly _tag: 'MissingSession'
      readonly operation: 'direct-volatility' | 'execution' | 'planning' | 'qualification-window' | 'signal-decision'
      readonly index: number
      readonly sessionCount: number
    }
  | {
      readonly _tag: 'MissingRecordValue'
      readonly operation: 'bar' | 'price' | 'target-weight'
      readonly key: string
      readonly context: string
    }
  | {
      readonly _tag: 'RecordAccessFailed'
      readonly operation: 'bar' | 'position' | 'price' | 'target-weight'
      readonly key: string
      readonly context: string
      readonly reason: 'introspection-failed' | 'non-data-property'
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'InvalidStatisticInput'
      readonly statistic: 'mean' | 'sample-standard-deviation'
      readonly reason: 'empty' | 'not-finite'
      readonly values: readonly number[]
    }
  | {
      readonly _tag: 'InvalidWeight'
      readonly operation: 'quantize' | 'direct-volatility'
      readonly value: number
      readonly reason: 'negative' | 'not-finite'
    }
  | {
      readonly _tag: 'InvalidPerformanceInput'
      readonly reason: 'empty-equity' | 'invalid-equity' | 'invalid-initial-capital' | 'invalid-total'
      readonly index: number | null
      readonly value: number | null
    }
  | {
      readonly _tag: 'InvalidFillAdjustment'
      readonly modeledFilledQuantityMicros: bigint
      readonly adjustedFilledQuantityMicros: bigint
    }
  | {
      readonly _tag: 'CandidateDecisionMissing'
      readonly signalIndex: number
      readonly executionIndex: number
    }
  | {
      readonly _tag: 'SimulationTraceMissing'
    }
  | {
      readonly _tag: 'InvalidSimulationRange'
      readonly startIndex: number
      readonly sessionCount: number
    }
  | {
      readonly _tag: 'DuplicateExecutionTarget'
      readonly executionIndex: number
    }
  | {
      readonly _tag: 'DecisionTargetMismatch'
      readonly signalDate: IsoDate
      readonly executionDate: IsoDate
      readonly decisionWeightsHash: string
      readonly targetWeightsHash: string
    }
  | {
      readonly _tag: 'NegativeSimulationCash'
      readonly sessionDate: IsoDate
      readonly cashMicros: bigint
    }
  | {
      readonly _tag: 'UnsupportedSimulationExecutionModel'
      readonly actual: string
      readonly required: 'bayn.execution-model.v2'
    }
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly operation:
        | 'cash-change'
        | 'decision'
        | 'decision-target'
        | 'fee'
        | 'fill'
        | 'input-manifest'
        | 'order'
        | 'parameter'
        | 'run-identity'
        | 'yield'
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'ContractConstructionFailed'
      readonly operation: 'run-identity' | 'strategy-protocol'
      readonly cause: ContractConstructionFailure
    }
  | {
      readonly _tag: 'RuntimeStrategyMismatch'
      readonly observed: string
      readonly expected: string
    }
  | {
      readonly _tag: 'RuntimeParameterSchemaMismatch'
      readonly observed: string
      readonly expected: string
    }
  | {
      readonly _tag: 'RuntimeParameterHashMismatch'
      readonly observed: string
      readonly expected: string
    }
  | {
      readonly _tag: 'InputManifestHashMismatch'
      readonly observed: string
      readonly expected: string
    }
  | {
      readonly _tag: 'QualificationCalendarMismatch'
      readonly expectedCount: number
      readonly observedCount: number
      readonly expectedFirst: IsoDate
      readonly observedFirst: IsoDate | null
      readonly expectedLast: IsoDate
      readonly observedLast: IsoDate | null
    }
  | {
      readonly _tag: 'NoEligibleMonthEndSignal'
    }
  | {
      readonly _tag: 'InsufficientComparableObservations'
      readonly observed: number
      readonly required: number
    }
  | {
      readonly _tag: 'InvalidWindowRequirement'
      readonly field: 'minimumObservations' | 'requiredHistorySessions'
      readonly value: number
    }

export type SimulationFailure = ExecutionModelFailure | SimulationDomainFailure

export const renderSimulationFailure = (failure: SimulationFailure): string => {
  switch (failure._tag) {
    case 'InvalidMonetaryValue':
      return `cannot quantize ${failure.reason} monetary value ${failure.value}`
    case 'InvalidMicrosString':
      return `${failure.field} is not an unsigned integer: ${failure.value}`
    case 'ManifestRowCountMismatch':
      return `strategy input has ${failure.observed} rows; manifest requires ${failure.expected}`
    case 'UnexpectedBarSymbol':
      return `strategy input symbol ${failure.symbol} is outside ${failure.universe.join(',')}`
    case 'DuplicateBar':
      return `strategy input contains duplicate ${failure.symbol} ${failure.sessionDate}`
    case 'ManifestSessionCountMismatch':
      return `strategy input has ${failure.observed} sessions; manifest requires ${failure.expected}`
    case 'IncompleteSession':
      return `strategy input session ${failure.sessionDate} has ${failure.observedSymbols.join(',')}; expected ${failure.expectedSymbols.join(',')}`
    case 'ManifestSessionBoundsMismatch':
      return `strategy input bounds ${failure.observedFirst ?? 'missing'}..${failure.observedLast ?? 'missing'} do not match ${failure.expectedFirst}..${failure.expectedLast}`
    case 'MissingSession':
      return `${failure.operation} requires session index ${failure.index} within ${failure.sessionCount} sessions`
    case 'MissingRecordValue':
      return `${failure.operation} ${failure.key} is missing from ${failure.context}`
    case 'RecordAccessFailed':
      return `${failure.operation} ${failure.key} cannot be read from ${failure.context}: ${failure.reason}`
    case 'InvalidStatisticInput':
      return `${failure.statistic} received ${failure.reason} input`
    case 'InvalidWeight':
      return `${failure.operation} weight is ${failure.reason}: ${failure.value}`
    case 'InvalidPerformanceInput':
      return `performance input is ${failure.reason}${failure.index === null ? '' : ` at index ${failure.index}`}`
    case 'InvalidFillAdjustment':
      return `buying-power fill adjustment ${failure.adjustedFilledQuantityMicros} must be within 0..${failure.modeledFilledQuantityMicros}`
    case 'CandidateDecisionMissing':
      return `candidate target ${failure.signalIndex}->${failure.executionIndex} has no strategy decision`
    case 'SimulationTraceMissing':
      return 'strategy simulation omitted its trace'
    case 'InvalidSimulationRange':
      return `simulation start index ${failure.startIndex} is outside ${failure.sessionCount} sessions`
    case 'DuplicateExecutionTarget':
      return `simulation has multiple targets for execution index ${failure.executionIndex}`
    case 'DecisionTargetMismatch':
      return `strategy decision ${failure.signalDate}->${failure.executionDate} diverges from its target`
    case 'NegativeSimulationCash':
      return `simulation cash is negative on ${failure.sessionDate}: ${failure.cashMicros}`
    case 'UnsupportedSimulationExecutionModel':
      return `simulation requires ${failure.required}; observed ${failure.actual}`
    case 'CanonicalizationFailed':
      return `${failure.operation} canonicalization failed at ${failure.cause.path}: ${failure.cause.reason}`
    case 'ContractConstructionFailed':
      return `${failure.operation} construction failed: ${failure.cause._tag}`
    case 'RuntimeStrategyMismatch':
      return `runtime strategy ${failure.observed} does not match ${failure.expected}`
    case 'RuntimeParameterSchemaMismatch':
      return `runtime parameter schema ${failure.observed} does not match ${failure.expected}`
    case 'RuntimeParameterHashMismatch':
      return `runtime parameter hash ${failure.observed} does not match ${failure.expected}`
    case 'InputManifestHashMismatch':
      return `input manifest hash ${failure.observed} does not match ${failure.expected}`
    case 'QualificationCalendarMismatch':
      return `qualification calendar ${failure.observedCount}:${failure.observedFirst ?? 'missing'}..${failure.observedLast ?? 'missing'} does not match ${failure.expectedCount}:${failure.expectedFirst}..${failure.expectedLast}`
    case 'NoEligibleMonthEndSignal':
      return 'dataset has no eligible month-end signal followed by an execution session'
    case 'InsufficientComparableObservations':
      return `dataset has ${failure.observed} comparable observations; ${failure.required} required`
    case 'InvalidWindowRequirement':
      return `${failure.field} must be a non-negative integer; observed ${failure.value}`
    default:
      return failure._tag
  }
}

export interface AlignedSession {
  readonly date: IsoDate
  readonly bars: Readonly<Record<string, DailyBar>>
}

export interface SimulationTarget {
  readonly signalIndex: number
  readonly executionIndex: number
  readonly weights: Readonly<Record<string, number>>
  readonly decision?: DecisionPlan
  /** Generic strategy definitions do not expose risk-specific signal evidence. */
  readonly requireDecisionEvidence?: boolean
  /** Terminal liquidation uses the same costs but must settle the modeled closing leg. */
  readonly terminalClose?: boolean
}

export interface SimulationResult {
  readonly metrics: PerformanceMetrics
  readonly events: readonly EvaluationEvent[]
  readonly signalDecisions: readonly SignalDecision[]
  readonly dailyPerformance: readonly DailyPerformancePoint[]
  readonly simulation: SimulationTrace | null
}

export type SimulationDecision = Result.Result<SimulationResult, SimulationFailure>

export interface SimulationInput {
  readonly sessions: readonly AlignedSession[]
  readonly targets: readonly SimulationTarget[]
  readonly terminalCloseTarget?: (target: SimulationTarget, executionIndex: number) => SimulationTarget
  readonly startIndex: number
  readonly protocol: SimulationProtocol
  readonly costMultiplierMicros: bigint
  readonly runId: string
  readonly recordEvents: boolean
}

export interface EvaluationWindow {
  readonly signalIndices: readonly number[]
  readonly startIndex: number
  readonly evaluationEndExclusive: number
}

export interface EvaluationIdentity {
  readonly runId: string
  readonly protocolHash: string
}

export interface PreparedOrder {
  readonly event: SimulatedOrder
  readonly filledQuantityMicros: bigint
}
