import type {
  EvaluationBounds,
  LegacyFinalizedSnapshotProvenance,
  UniverseBoundFinalizedSnapshotProvenance,
} from './contracts'

export type IsoDate = `${number}-${number}-${number}`

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
  AdjustedDailySnapshotV1 = 'signal.adjusted-daily-snapshot.v1',
  AdjustedDailySnapshotV2 = 'signal.adjusted-daily-snapshot.v2',
}

export enum ContractVersion {
  Evaluation = 'bayn.evaluation.v4',
  EvaluationSummary = 'bayn.evaluation-summary.v3',
  PartialFillSeed = 'bayn.partial-fill-seed.v1',
  RiskBalancedTrendDecisionPlan = 'bayn.risk-balanced-trend-decision-plan.v1',
  RiskBalancedTrendEvaluation = 'bayn.evaluation.v6',
  RiskBalancedTrendEvaluationSummary = 'bayn.evaluation-summary.v5',
  RunIdentity = 'bayn.run-identity.v1',
  SimulationTrace = 'bayn.simulation-trace.v3',
  TsmomDecisionPlan = 'bayn.tsmom-decision-plan.v1',
}

export const DIRECT_VOLATILITY_WINDOW = 63

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

export interface SymbolCoverage {
  readonly symbol: string
  readonly rows: number
  readonly firstSession: IsoDate
  readonly lastSession: IsoDate
}

interface InputManifestBase {
  readonly hash: string
  readonly database: 'signal'
  readonly bounds: EvaluationBounds
  readonly rowCount: number
  readonly sessionCount: number
  readonly firstSession: IsoDate
  readonly lastSession: IsoDate
  readonly symbols: readonly SymbolCoverage[]
}

export interface LegacyInputManifest extends InputManifestBase {
  readonly schemaVersion: 'bayn.input-manifest.v2'
  readonly tables: {
    readonly bars: 'adjusted_daily_bars_v2'
    readonly sessions: 'exchange_sessions_v1'
    readonly manifests: 'snapshot_manifests_v1'
  }
  readonly finalizedSnapshot: LegacyFinalizedSnapshotProvenance
}

export interface UniverseBoundInputManifest extends InputManifestBase {
  readonly schemaVersion: 'bayn.input-manifest.v3'
  readonly tables: {
    readonly bars: 'adjusted_daily_bars_v2'
    readonly sessions: 'exchange_sessions_v1'
    readonly manifests: 'snapshot_manifests_v2'
  }
  readonly finalizedSnapshot: UniverseBoundFinalizedSnapshotProvenance
}

export type InputManifest = LegacyInputManifest | UniverseBoundInputManifest

export interface EconomicThresholds {
  readonly minimumObservations: number
  readonly minimumAnnualizedReturn: number
  readonly minimumSharpeImprovement: number
  readonly maximumDrawdown: number
  readonly maximumAnnualTurnover: number
  readonly requirePositiveDoubleCostReturn: boolean
}

export interface ExecutionModel {
  readonly schemaVersion: 'bayn.execution-model.v1'
  readonly venue: 'alpaca-paper'
  readonly assetClass: 'us-equity'
  readonly order: {
    readonly type: 'market'
    readonly timeInForce: 'day'
    readonly extendedHours: false
    readonly submitAfter: 'signal-session-close'
    readonly submitBefore: 'next-session-open'
    readonly priceReference: 'next-session-open'
  }
  readonly precision: {
    readonly quantityIncrementMicros: string
    readonly priceIncrementMicros: string
    readonly minimumBuyNotionalMicros: string
  }
  readonly priceImpact: {
    readonly halfSpreadBps: number
    readonly slippageBps: number
  }
  readonly fees: {
    readonly scheduleVersion: 'alpaca-brokerage-2026-07-01'
    readonly commissionBps: number
    readonly secSellBps: number
    readonly tafSellPerShareMicros: string
    readonly tafMaximumPerOrderMicros: string
    readonly catPerShareMicros: string
    readonly aggregation: 'session-by-fee-type'
    readonly roundingIncrementMicros: string
  }
  readonly cash: {
    readonly annualYieldBps: number
    readonly dayCount: 'actual-365'
    readonly accrual: 'session-open'
  }
  readonly partialFills: {
    readonly policy: 'deterministic-hash'
    readonly probabilityPpm: number
    readonly filledFractionPpm: number
    readonly remainder: 'cancel'
  }
  readonly doubleCostMultiplier: 2
}

export interface TsmomProtocol {
  readonly schemaVersion: 'bayn.tsmom.protocol.v2'
  readonly universe: readonly string[]
  readonly lookbacks: readonly number[]
  readonly rebalance: 'month-end'
  readonly positionPolicy: 'long-or-cash'
  readonly directVolatilityTarget: number
  readonly initialCapitalMicros: string
  readonly executionModel: ExecutionModel
  readonly thresholds: EconomicThresholds
}

export interface RiskBalancedTrendProtocol {
  readonly schemaVersion: 'bayn.risk-balanced-trend.protocol.v2'
  readonly universeId: 'equity-infrastructure-v1'
  readonly universeSymbolHash: string
  readonly universe: readonly string[]
  readonly historyStart: IsoDate
  readonly evaluationStart: IsoDate
  readonly horizons: readonly number[]
  readonly volatilityWindow: number
  readonly rebalance: 'month-end'
  readonly positionPolicy: 'long-or-cash'
  readonly maximumSymbolWeight: number
  readonly maximumPortfolioVolatility: number
  readonly directVolatilityTarget: number
  readonly initialCapitalMicros: string
  readonly executionModel: ExecutionModel
  readonly thresholds: EconomicThresholds
}

export interface SimulationProtocol {
  readonly universe: readonly string[]
  readonly directVolatilityTarget: number
  readonly initialCapitalMicros: string
  readonly executionModel: ExecutionModel
  readonly thresholds: EconomicThresholds
}

export type StrategyProtocol = TsmomProtocol | RiskBalancedTrendProtocol

export interface TsmomLookbackSignal {
  readonly lookbackSessions: number
  readonly return: number
  readonly direction: 'positive' | 'non-positive'
}

export interface TsmomSymbolSignal {
  readonly symbol: string
  readonly lookbacks: readonly TsmomLookbackSignal[]
  readonly score: number
  readonly active: boolean
  readonly targetWeight: number
}

export interface TsmomDecisionPlan {
  readonly schemaVersion: 'bayn.tsmom-decision-plan.v1'
  readonly signalDate: IsoDate
  readonly targetWeights: Readonly<Record<string, number>>
  readonly signals: readonly TsmomSymbolSignal[]
}

export interface TsmomSignalDecision extends TsmomDecisionPlan {
  readonly decisionId: string
  readonly executionDate: IsoDate
}

export interface RiskBalancedTrendHorizonSignal {
  readonly horizonSessions: number
  readonly return: number
  readonly normalizedTrend: number
}

export interface RiskBalancedTrendSymbolSignal {
  readonly symbol: string
  readonly horizons: readonly RiskBalancedTrendHorizonSignal[]
  readonly dailyVolatility: number
  readonly annualizedVolatility: number
  readonly compositeScore: number
  readonly positiveScore: number
  readonly eligible: boolean
  readonly uncappedWeight: number
  readonly cappedWeight: number
  readonly targetWeight: number
}

export interface RiskBalancedTrendDecisionPlan {
  readonly schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1'
  readonly signalDate: IsoDate
  readonly covarianceWindow: {
    readonly returnCount: number
    readonly firstSession: IsoDate
    readonly lastSession: IsoDate
    readonly sessionsHash: string
  }
  readonly estimatedAnnualizedPortfolioVolatility: number
  readonly exposureScale: number
  readonly targetWeights: Readonly<Record<string, number>>
  readonly signals: readonly RiskBalancedTrendSymbolSignal[]
}

export interface RiskBalancedTrendSignalDecision extends RiskBalancedTrendDecisionPlan {
  readonly decisionId: string
  readonly executionDate: IsoDate
}

export type StrategyDecisionPlan = TsmomDecisionPlan | RiskBalancedTrendDecisionPlan
export type StrategySignalDecision = TsmomSignalDecision | RiskBalancedTrendSignalDecision

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
  readonly referencePriceMicros: string
  readonly priceMicros: string
  readonly notionalMicros: string
  readonly spreadCostMicros: string
  readonly slippageCostMicros: string
  readonly costBasisMicros: string
}

export interface FeeEvent {
  readonly kind: 'fee'
  readonly id: string
  readonly sessionDate: IsoDate
  readonly commissionMicros: string
  readonly secMicros: string
  readonly tafMicros: string
  readonly catMicros: string
  readonly totalMicros: string
}

export interface CashYieldEvent {
  readonly kind: 'cash-yield'
  readonly id: string
  readonly sessionDate: IsoDate
  readonly elapsedDays: number
  readonly annualYieldBps: number
  readonly amountMicros: string
}

export type EvaluationEvent = DecisionEvent | FillEvent | FeeEvent | CashYieldEvent

export type OrderStatus = 'filled' | 'partially-filled' | 'rejected'
export type OrderRejectionReason = 'below-minimum-buy-notional' | 'zero-after-rounding'

export interface SimulatedOrder {
  readonly id: string
  readonly decisionId: string
  readonly sessionDate: IsoDate
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly requestedQuantityMicros: string
  readonly filledQuantityMicros: string
  readonly status: OrderStatus
  readonly rejectionReason: OrderRejectionReason | null
  readonly unfilledRemainder: 'none' | 'canceled'
}

export interface CashChange {
  readonly id: string
  readonly sourceKind: 'fill' | 'fee' | 'cash-yield'
  readonly sourceId: string
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
  readonly netReturn: number
  readonly turnoverMicros: string
  readonly cumulativeTurnoverMicros: string
  readonly feeMicros: string
  readonly cumulativeFeesMicros: string
  readonly spreadCostMicros: string
  readonly cumulativeSpreadCostMicros: string
  readonly slippageCostMicros: string
  readonly cumulativeSlippageCostMicros: string
  readonly cashYieldMicros: string
  readonly cumulativeCashYieldMicros: string
  readonly peakEquityMicros: string
  readonly drawdown: number
}

export interface DailyPerformancePoint {
  readonly sessionDate: IsoDate
  readonly equityMicros: string
  readonly netReturn: number
  readonly turnoverMicros: string
  readonly cumulativeTurnoverMicros: string
  readonly feeMicros: string
  readonly cumulativeFeesMicros: string
  readonly spreadCostMicros: string
  readonly cumulativeSpreadCostMicros: string
  readonly slippageCostMicros: string
  readonly cumulativeSlippageCostMicros: string
  readonly cashYieldMicros: string
  readonly cumulativeCashYieldMicros: string
  readonly peakEquityMicros: string
  readonly drawdown: number
}

export interface SimulationTrace {
  readonly schemaVersion: 'bayn.simulation-trace.v3'
  readonly executionModel: ExecutionModel
  readonly costMultiplierMicros: string
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
  readonly schemaVersion: 'bayn.marked-equity-reconciliation.v2'
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
  readonly totalSpreadCostMicros: string
  readonly totalSlippageCostMicros: string
  readonly totalCashYieldMicros: string
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

interface EvaluationResultBase<Manifest extends InputManifest = InputManifest> {
  readonly runId: string
  readonly codeRevision: string
  readonly protocolHash: string
  readonly initialCapitalMicros: string
  readonly inputManifest: Manifest
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
}

export interface TsmomEvaluationResult extends EvaluationResultBase {
  readonly schemaVersion: 'bayn.evaluation.v4'
  readonly signalDecisions: readonly TsmomSignalDecision[]
}

export interface RiskBalancedTrendEvaluationResult extends EvaluationResultBase<UniverseBoundInputManifest> {
  readonly schemaVersion: 'bayn.evaluation.v6'
  readonly signalDecisions: readonly RiskBalancedTrendSignalDecision[]
}

export type EvaluationResult = TsmomEvaluationResult | RiskBalancedTrendEvaluationResult

interface EvaluationSummaryBase {
  readonly runId: string
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
  readonly signalDecisionCount: number
  readonly orderCount: number
  readonly cashChangeCount: number
  readonly dailyMarkCount: number
  readonly benchmarkSeriesCounts: {
    readonly buyAndHold: number
    readonly directVolTiming: number
    readonly doubleCostStrategy: number
  }
  readonly markedEquityReconciliation: MarkedEquityReconciliation
}

export interface TsmomEvaluationSummary extends EvaluationSummaryBase {
  readonly schemaVersion: 'bayn.evaluation-summary.v3'
  readonly evaluationSchemaVersion: 'bayn.evaluation.v4'
}

export interface RiskBalancedTrendEvaluationSummary extends EvaluationSummaryBase {
  readonly schemaVersion: 'bayn.evaluation-summary.v5'
  readonly evaluationSchemaVersion: 'bayn.evaluation.v6'
}

export type EvaluationSummary = TsmomEvaluationSummary | RiskBalancedTrendEvaluationSummary

export interface ReconciliationResult {
  readonly runId: string
  readonly accountCount: number
  readonly transferCount: number
  readonly exact: true
}
