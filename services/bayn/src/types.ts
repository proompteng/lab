import type { EvaluationBounds, FinalizedSnapshotProvenance } from './contracts'

export type IsoDate = `${number}-${number}-${number}`

export interface DailyBar {
  readonly symbol: string
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly source: string
  readonly sourceFeed: string
  readonly adjustment: string
  readonly publicationSchemaVersion: string
}

export interface SymbolCoverage {
  readonly symbol: string
  readonly rows: number
  readonly firstSession: IsoDate
  readonly lastSession: IsoDate
}

export interface InputManifest {
  readonly schemaVersion: 'bayn.input-manifest.v2'
  readonly hash: string
  readonly database: 'signal'
  readonly tables: {
    readonly bars: 'adjusted_daily_bars_v2'
    readonly sessions: 'exchange_sessions_v1'
    readonly manifests: 'snapshot_manifests_v1'
  }
  readonly finalizedSnapshot: FinalizedSnapshotProvenance
  readonly bounds: EvaluationBounds
  readonly rowCount: number
  readonly sessionCount: number
  readonly firstSession: IsoDate
  readonly lastSession: IsoDate
  readonly symbols: readonly SymbolCoverage[]
}

export interface EconomicThresholds {
  readonly minimumObservations: number
  readonly minimumAnnualizedReturn: number
  readonly minimumSharpeImprovement: number
  readonly maximumDrawdown: number
  readonly maximumAnnualTurnover: number
  readonly requirePositiveDoubleCostReturn: boolean
}

export interface TsmomProtocol {
  readonly schemaVersion: 'bayn.tsmom.protocol.v1'
  readonly universe: readonly string[]
  readonly lookbacks: readonly number[]
  readonly rebalance: 'month-end'
  readonly execution: 'next-session-open'
  readonly positionPolicy: 'long-or-cash'
  readonly directVolatilityTarget: number
  readonly initialCapitalMicros: string
  readonly transactionCostBps: number
  readonly thresholds: EconomicThresholds
}

export interface DecisionEvent {
  readonly kind: 'decision'
  readonly id: string
  readonly signalDate: IsoDate
  readonly executionDate: IsoDate
  readonly targetWeights: Readonly<Record<string, number>>
}

export interface FillEvent {
  readonly kind: 'fill'
  readonly id: string
  readonly orderId: string
  readonly decisionId: string
  readonly sessionDate: IsoDate
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly quantityMicros: string
  readonly priceMicros: string
  readonly notionalMicros: string
  readonly feeMicros: string
  readonly costBasisMicros: string
}

export type EvaluationEvent = DecisionEvent | FillEvent

export interface SimulatedOrder {
  readonly id: string
  readonly decisionId: string
  readonly sessionDate: IsoDate
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly requestedQuantityMicros: string
  readonly filledQuantityMicros: string
}

export interface CashChange {
  readonly id: string
  readonly fillId: string
  readonly sessionDate: IsoDate
  readonly amountMicros: string
  readonly cashAfterMicros: string
}

export interface PositionMark {
  readonly symbol: string
  readonly quantityMicros: string
  readonly costBasisMicros: string
  readonly priceMicros: string
  readonly marketValueMicros: string
}

export interface DailyPositionMark {
  readonly sessionDate: IsoDate
  readonly cashMicros: string
  readonly positions: readonly PositionMark[]
  readonly equityMicros: string
}

export interface SimulationTrace {
  readonly schemaVersion: 'bayn.simulation-trace.v1'
  readonly transactionCostBpsMicros: string
  readonly orders: readonly SimulatedOrder[]
  readonly cashChanges: readonly CashChange[]
  readonly dailyMarks: readonly DailyPositionMark[]
}

export interface EquityPoint {
  readonly sessionDate: IsoDate
  readonly evaluatorEquityMicros: string
  readonly reconstructedEquityMicros: string
  readonly differenceMicros: string
}

export interface MarkedEquityReconciliation {
  readonly schemaVersion: 'bayn.marked-equity-reconciliation.v1'
  readonly runId: string
  readonly toleranceMicros: string
  readonly maximumDailyDifferenceMicros: string
  readonly reconstructedCashMicros: string
  readonly reconstructedPositionValueMicros: string
  readonly evaluatorTotalFeesMicros: string
  readonly reconstructedTotalFeesMicros: string
  readonly feeDifferenceMicros: string
  readonly evaluatorEndingEquityMicros: string
  readonly reconstructedEndingEquityMicros: string
  readonly differenceMicros: string
  readonly exact: boolean
  readonly withinTolerance: true
}

export interface PerformanceMetrics {
  readonly observations: number
  readonly totalReturn: number
  readonly annualizedReturn: number
  readonly annualizedVolatility: number
  readonly sharpe: number
  readonly maximumDrawdown: number
  readonly annualTurnover: number
  readonly totalFeesMicros: string
  readonly endingEquityMicros: string
}

export interface GateResult {
  readonly name: string
  readonly passed: boolean
  readonly actual: number | boolean | string
  readonly required: number | boolean | string
}

export interface EconomicVerdict {
  readonly status: 'PASS' | 'FAIL_CLOSED'
  readonly gates: readonly GateResult[]
}

export interface EvaluationResult {
  readonly schemaVersion: 'bayn.evaluation.v2'
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
  readonly equitySeries: readonly EquityPoint[]
  readonly markedEquityReconciliation: MarkedEquityReconciliation
}

export interface EvaluationSummary {
  readonly schemaVersion: 'bayn.evaluation-summary.v1'
  readonly runId: string
  readonly evaluationSchemaVersion: 'bayn.evaluation.v2'
  readonly codeRevision: string
  readonly protocolHash: string
  readonly initialCapitalMicros: string
  readonly input: {
    readonly snapshotId: string
    readonly publicationId: string
    readonly manifestHash: string
    readonly bounds: EvaluationBounds
    readonly rowCount: number
    readonly sessionCount: number
    readonly symbols: readonly string[]
  }
  readonly strategy: PerformanceMetrics
  readonly buyAndHold: PerformanceMetrics
  readonly directVolTiming: PerformanceMetrics
  readonly doubleCostStrategy: PerformanceMetrics
  readonly verdict: EconomicVerdict
  readonly eventCount: number
  readonly orderCount: number
  readonly cashChangeCount: number
  readonly dailyMarkCount: number
  readonly markedEquityReconciliation: MarkedEquityReconciliation
}

export interface ReconciliationResult {
  readonly runId: string
  readonly accountCount: number
  readonly transferCount: number
  readonly exact: true
}
