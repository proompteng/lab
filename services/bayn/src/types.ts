import type {
  CashChange,
  DailyPerformancePoint,
  DailyPositionMark,
  EconomicVerdict,
  EquityPoint,
  EvaluationEvent,
  InputManifest,
  MarkedEquityReconciliation,
  PerformanceMetrics,
  SignalDecision,
  SimulatedOrder,
} from './evidence-contracts'
import type { EconomicThresholds, ExecutionModel } from './protocol'
import type { IsoDate } from './schemas'

export type {
  CashChange,
  CashYieldEvent,
  DailyPerformancePoint,
  DailyPositionMark,
  DecisionEvent,
  DecisionPlan,
  EconomicVerdict,
  EquityPoint,
  EvaluationEvent,
  EvaluationSummary,
  FeeEvent,
  FillEvent,
  GateResult,
  HorizonSignal,
  InputManifest,
  MarkedEquityReconciliation,
  OrderRejectionReason,
  OrderStatus,
  PerformanceMetrics,
  PositionMark,
  ReconciliationResult,
  SignalDecision,
  SimulatedOrder,
  SymbolCoverage,
  SymbolSignal,
} from './evidence-contracts'
export type { EconomicThresholds, ExecutionModel, Protocol } from './protocol'
export { DIRECT_VOLATILITY_WINDOW } from './protocol'
export type { IsoDate } from './schemas'

export enum DataSource {
  Alpaca = 'alpaca',
}

export enum DataFeed {
  Sip = 'sip',
}

export enum PriceAdjustment {
  All = 'all',
}

export enum PublicationSchema {
  AdjustedDailySnapshotV2 = 'signal.adjusted-daily-snapshot.v2',
}

export enum ContractVersion {
  DecisionPlan = 'bayn.risk-balanced-trend-decision-plan.v1',
  Evaluation = 'bayn.evaluation.v6',
  EvaluationSummary = 'bayn.evaluation-summary.v5',
  PartialFillSeed = 'bayn.partial-fill-seed.v1',
  RunIdentity = 'bayn.run-identity.v1',
  SimulationTrace = 'bayn.simulation-trace.v3',
}

export interface DailyBar {
  readonly symbol: string
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly source: DataSource
  readonly sourceFeed: DataFeed
  readonly adjustment: PriceAdjustment
  readonly publicationSchemaVersion: PublicationSchema
}

export interface SimulationProtocol {
  readonly universe: readonly string[]
  readonly directVolatilityTarget: number
  readonly initialCapitalMicros: string
  readonly executionModel: ExecutionModel
  readonly thresholds: EconomicThresholds
}

export interface SimulationTrace {
  readonly schemaVersion: 'bayn.simulation-trace.v3'
  readonly executionModel: ExecutionModel
  readonly costMultiplierMicros: string
  readonly orders: readonly SimulatedOrder[]
  readonly cashChanges: readonly CashChange[]
  readonly dailyMarks: readonly DailyPositionMark[]
}

export interface EvaluationResult {
  readonly schemaVersion: 'bayn.evaluation.v6'
  readonly runId: string
  readonly codeRevision: string
  readonly protocolHash: string
  readonly initialCapitalMicros: string
  readonly inputManifest: InputManifest
  readonly strategy: PerformanceMetrics
  readonly buyAndHold: PerformanceMetrics
  readonly directVolTiming: PerformanceMetrics
  readonly doubleCostStrategy: PerformanceMetrics
  readonly verdict: EconomicVerdict
  readonly events: readonly EvaluationEvent[]
  readonly simulation: SimulationTrace
  readonly benchmarkSeries: {
    readonly buyAndHold: readonly DailyPerformancePoint[]
    readonly directVolTiming: readonly DailyPerformancePoint[]
    readonly doubleCostStrategy: readonly DailyPerformancePoint[]
  }
  readonly equitySeries: readonly EquityPoint[]
  readonly markedEquityReconciliation: MarkedEquityReconciliation
  readonly signalDecisions: readonly SignalDecision[]
}
