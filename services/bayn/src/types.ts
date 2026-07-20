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
  readonly schemaVersion: 'bayn.evaluation.v1'
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
}

export interface ReconciliationResult {
  readonly runId: string
  readonly accountCount: number
  readonly transferCount: number
  readonly exact: true
}
