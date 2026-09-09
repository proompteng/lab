import type { FinalizedSnapshotProvenance } from '../contracts'
import type { IsoDate } from '../schemas'

export const FORWARD_PERFORMANCE_SCHEMA_VERSION = 'bayn.forward-performance-receipt.v3' as const

export type ForwardPerformanceEvidenceStatus = 'SUFFICIENT' | 'INSUFFICIENT_EVIDENCE'
export type ForwardPerformanceProfitability = 'PROFITABLE' | 'NOT_PROFITABLE' | 'UNDETERMINED'
export type ForwardPerformanceMeasurementStatus = 'MEASURED' | 'NOT_ELIGIBLE' | 'UNDETERMINED'

export type ForwardPerformanceReasonCode =
  | 'ACCOUNT_IDENTITY_GAP'
  | 'ACCOUNTING_RECEIPT_MISMATCH'
  | 'CASH_YIELD_EVIDENCE_GAP'
  | 'CYCLE_IDENTITY_DRIFT'
  | 'IDENTITY_GAP'
  | 'INVALID_MICROS'
  | 'LEDGER_MISMATCH'
  | 'MISSING_LEDGER_ACCOUNT'
  | 'NON_EXACT_RECONCILIATION'
  | 'OPEN_POSITION'
  | 'STARTING_CAPITAL_GAP'
  | 'UNCLOSED_WINDOW'
  | 'UNRESOLVED_MUTATION'
  | 'ZERO_COMPLETED_EXECUTIONS'

export type ForwardPerformanceExecutionQualityReasonCode =
  | 'ACCOUNT_LEDGER_RECONCILIATION_GAP'
  | 'ACCOUNTING_FILL_BINDING_GAP'
  | 'DUPLICATE_EXECUTION_EVIDENCE'
  | 'EXPLICIT_COST_EVIDENCE_GAP'
  | 'FILL_EVIDENCE_GAP'
  | 'FILL_IDENTITY_DRIFT'
  | 'FILL_QUANTITY_MISMATCH'
  | 'FILL_TIMESTAMP_GAP'
  | 'INVALID_EXECUTION_MICROS'
  | 'PLANNED_DECISION_EVIDENCE_GAP'
  | 'REFERENCE_PRICE_EVIDENCE_GAP'
  | 'TERMINAL_ORDER_EVIDENCE_GAP'
  | 'TERMINAL_PRICE_EVIDENCE_GAP'
  | 'ZERO_COMPLETED_EXECUTIONS'

export type ForwardPerformanceObservedCapacityReasonCode =
  | 'EXECUTION_QUALITY_UNDETERMINED'
  | 'INVALID_MARKET_VOLUME_EVIDENCE'
  | 'MARKET_VOLUME_EVIDENCE_GAP'
  | 'MARKET_VOLUME_IDENTITY_DRIFT'
  | 'ZERO_COMPLETED_EXECUTIONS'

export interface ForwardPerformanceBuildBinding {
  readonly sourceRevision: string
  readonly imageRepository: string
  readonly imageDigest: string
}

export interface ForwardPerformanceStrategyBinding {
  readonly qualificationRunId: string
  readonly strategyName: string
  readonly strategyProtocolHash: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly strategyParameterSchemaVersion: string
  readonly executionPolicyHash: string
  readonly strategyExecutionModelHash: string
}

export interface ForwardPerformanceAccountBinding {
  readonly accountReferenceHash: string
  readonly provider: string
  readonly environment: string
}

export interface ForwardPerformanceCycleEvidence {
  readonly cycleId: string
  readonly qualificationRunId: string
  readonly strategyName: string
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly executionPolicyHash: string
  readonly strategyExecutionModelHash: string
  readonly state: 'COMPLETED' | 'NO_TRADE'
  readonly submissionOpenAt: string
  readonly terminalAt: string
}

export interface ForwardPerformanceStrategyEvidence {
  readonly qualificationRunId: string
  readonly strategyName: string
  readonly strategyProtocolHash: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly strategyParameterSchemaVersion: string
  readonly sourceRevision: string
  readonly imageRepository: string
  readonly imageDigest: string
}

export interface ForwardPerformanceTransactionEvidence {
  readonly transactionId: string
  readonly brokerEventId?: string
  readonly intentId?: string
  readonly cycleId: string
  readonly symbol?: string
  readonly side: 'BUY' | 'SELL'
  readonly quantityMicros?: string
  readonly priceMicros?: string
  readonly notionalMicros?: string
  readonly feeMicros: string
  readonly realizedPnlMicros: string
  readonly occurredAt: string
}

export interface ForwardPerformanceExecutionFillEvidence {
  readonly brokerEventId: string
  readonly fillId: string
  readonly brokerOrderId: string
  readonly clientOrderId: string
  readonly intentId: string
  readonly accountId: string
  readonly symbol: string
  readonly side: 'BUY' | 'SELL'
  readonly quantityMicros: string
  readonly priceMicros: string
  readonly feeMicros: string
  readonly sourceTimestamp: string
  readonly occurredAt: string
  readonly observedAt: string
}

export interface ForwardPerformanceExecutionEvidence {
  readonly cycleId: string
  readonly decisionDocumentHash: string
  readonly decisionHash: string
  readonly decisionCreatedAt: string
  readonly intentId: string
  readonly accountId: string
  readonly symbol: string
  readonly side: 'BUY' | 'SELL'
  readonly plannedQuantityMicros?: string
  readonly referencePriceMicros?: string
  readonly intent?: {
    readonly intentId: string
    readonly accountId: string
    readonly clientOrderId: string
    readonly cycleId: string
    readonly decisionHash: string
    readonly symbol: string
    readonly side: 'BUY' | 'SELL'
    readonly quantityMicros: string
    readonly notionalLimitMicros?: string
    readonly terminalOutcome: 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'BLOCKED'
    readonly createdAt: string
    readonly updatedAt: string
  }
  readonly terminalOrder?: {
    readonly eventId: string
    readonly brokerOrderId: string
    readonly clientOrderId: string
    readonly intentId: string
    readonly accountId: string
    readonly symbol: string
    readonly side: 'BUY' | 'SELL'
    readonly quantityMicros?: string
    readonly notionalMicros?: string
    readonly filledQuantityMicros: string
    readonly status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'PENDING'
    readonly occurredAt: string
    readonly observedAt: string
  }
  readonly fills: readonly ForwardPerformanceExecutionFillEvidence[]
  readonly terminalReferencePrice?: {
    readonly schemaVersion: 'bayn.forward-performance-terminal-reference-price.v1'
    readonly cycleId: string
    readonly symbol: string
    readonly executionSessionDate: IsoDate
    readonly priceMicros: string
    readonly observedAt: string
    readonly sourceEvidenceHash: string
    readonly contentHash: string
  }
}

export interface ForwardPerformanceMarketVolumeEvidence {
  readonly schemaVersion: 'bayn.forward-performance-market-volume-evidence.v1'
  readonly cycleId: string
  readonly decisionSnapshotId: string
  readonly decisionSnapshotAsOfSession: IsoDate
  readonly symbol: string
  readonly executionSessionDate: IsoDate
  readonly windowOpenedAt: string
  readonly windowClosedAt: string
  readonly evidenceCutoffAt: string
  readonly quantityMicros: string
  readonly closePriceMicros: string
  readonly snapshotId: string
  readonly manifestContentHash: string
  readonly barsContentHash: string
  readonly finalizedAt: string
  readonly universeId: FinalizedSnapshotProvenance['universeId']
  readonly universeSymbolHash: string
  readonly requestedStart: IsoDate
  readonly evaluationStart: IsoDate
  readonly calendarVersion: string
  readonly source: 'alpaca'
  readonly sourceFeed: 'sip'
  readonly adjustment: 'all'
  readonly contentHash: string
}

export interface ForwardPerformanceMarketVolumeRequest {
  readonly cycleId: string
  readonly decisionSnapshotId: string
  readonly decisionSnapshotAsOfSession: IsoDate
  readonly symbol: string
  readonly executionSessionDate: IsoDate
  readonly windowOpenedAt: string
  readonly windowClosedAt: string
  readonly evidenceCutoffAt: string
  readonly universeId: FinalizedSnapshotProvenance['universeId']
  readonly universeSymbolHash: string
  readonly symbols: FinalizedSnapshotProvenance['symbols']
  readonly requestedStart: IsoDate
  readonly calendarVersion: string
  readonly source: 'alpaca'
  readonly sourceFeed: 'sip'
  readonly adjustment: 'all'
}

export interface ForwardPerformanceLedgerTotals {
  readonly realizedGainMicros: string
  readonly realizedLossMicros: string
  readonly brokerExecutionFeesMicros: string
  readonly otherChargedCostsMicros: string
  readonly cashYieldMicros: string
}

export interface ForwardPerformanceCashYieldEvidence {
  readonly schemaVersion: 'bayn.forward-performance-cash-yield-evidence.v1'
  readonly reconciliationId: string
  readonly reconciliationContentHash: string
  readonly reconciledAt: string
  readonly baselineAccountEventId: string
  readonly baselineObservedAt: string
  readonly baselineCashMicros: string
  readonly openingAccountEventId: string
  readonly openingObservedAt: string
  readonly openingCashMicros: string
  readonly preWindowAccountedCashDeltaMicros: string
  readonly preWindowCashResidualMicros: string
  readonly closingAccountEventId: string
  readonly closingObservedAt: string
  readonly closingCashMicros: string
  readonly accountedCashDeltaMicros: string
  readonly cashYieldMicros: string
}

export interface ForwardPerformanceCashYieldBinding {
  readonly source: 'TIGERBEETLE_CASH_YIELD_TRANSFER'
  readonly transferId: string
  readonly transferTimestampNs: string
  readonly amountMicros: string
}

export interface ForwardPerformanceEvidenceInput {
  readonly runtime: ForwardPerformanceBuildBinding
  readonly account: {
    readonly accountId: string
    readonly accountReferenceHash: string
    readonly provider: string
    readonly environment: string
  }
  readonly durableExecutionBindings: readonly {
    readonly accountId: string
    readonly accountReferenceHash: string
    readonly provider: string
    readonly environment: string
    readonly qualificationRunId: string
    readonly strategyName: string
    readonly strategyProtocolHash: string
    readonly strategyBehaviorHash: string
    readonly strategyParameterHash: string
    readonly strategyParameterSchemaVersion: string
    readonly executionPolicyHash: string
    readonly sourceRevision: string
    readonly imageRepository: string
    readonly imageDigest: string
  }[]
  readonly cycles: readonly ForwardPerformanceCycleEvidence[]
  readonly strategy?: ForwardPerformanceStrategyEvidence
  readonly reconciliation?: {
    readonly reconciliationId: string
    readonly contentHash: string
    readonly status: 'EXACT' | 'DISCREPANCY'
    readonly performanceExact: boolean
    readonly cashYieldAdjustedExact: boolean
    readonly reconciledAt: string
  }
  readonly startingCapitalMicros?: string
  readonly transactions: readonly ForwardPerformanceTransactionEvidence[]
  readonly executionEvidence?: readonly ForwardPerformanceExecutionEvidence[]
  readonly marketVolumeEvidence?: readonly ForwardPerformanceMarketVolumeEvidence[]
  readonly ledgerTotals?: ForwardPerformanceLedgerTotals
  readonly cashYieldEvidenceRequired: boolean
  readonly cashYieldEvidence?: ForwardPerformanceCashYieldBinding
  readonly accountingReceiptsExact: boolean
  readonly ledgerExact: boolean
  readonly missingLedgerAccountCount: number
  readonly unresolvedMutationCount: number
  readonly unclosedCycleCount: number
  readonly openPositionCount: number
}

export interface ForwardPerformanceReceiptMaterial {
  readonly schemaVersion: typeof FORWARD_PERFORMANCE_SCHEMA_VERSION
  readonly bindings: {
    readonly runtime: ForwardPerformanceBuildBinding
    readonly source: ForwardPerformanceBuildBinding | null
    readonly strategy: ForwardPerformanceStrategyBinding | null
    readonly account: ForwardPerformanceAccountBinding
  }
  readonly window: {
    readonly firstCycleId: string | null
    readonly lastCycleId: string | null
    readonly openedAt: string | null
    readonly closedAt: string | null
    readonly reconciliationId: string | null
    readonly reconciliationContentHash: string | null
    readonly reconciliationStatus: 'EXACT' | 'DISCREPANCY' | null
    readonly cashYieldAdjustedExact: boolean | null
  }
  readonly totals: {
    readonly startingCapitalMicros: string | null
    readonly realizedGainsMicros: string | null
    readonly realizedLossesMicros: string | null
    readonly brokerExecutionFeesMicros: string | null
    readonly otherChargedCostsMicros: string | null
    readonly cashYieldMicros: string | null
    readonly grossRealizedPnlMicros: string | null
    readonly netRealizedPnlAfterCostsMicros: string | null
    readonly netRealizedReturn: {
      readonly numeratorMicros: string
      readonly denominatorMicros: string
      readonly decimal: string
    } | null
  }
  readonly counts: {
    readonly cycleCount: number
    readonly completedExecutionCount: number
    readonly realizedCloseCount: number
  }
  readonly evidence: {
    readonly status: ForwardPerformanceEvidenceStatus
    readonly reasonCodes: readonly ForwardPerformanceReasonCode[]
    readonly cashYield: ForwardPerformanceCashYieldBinding | null
  }
  readonly reconciliationProof: {
    readonly accountingReceiptsExact: boolean
    readonly ledgerExact: boolean
    readonly missingLedgerAccountCount: number
    readonly unresolvedMutationCount: number
    readonly unclosedCycleCount: number
    readonly openPositionCount: number
  }
  readonly executionQuality: {
    readonly status: ForwardPerformanceMeasurementStatus
    readonly reasonCodes: readonly ForwardPerformanceExecutionQualityReasonCode[]
    readonly evidenceHash: string | null
    readonly implementationShortfall: {
      readonly plannedOrderCount: number
      readonly fillCount: number
      readonly plannedQuantityMicros: string
      readonly filledQuantityMicros: string
      readonly unfilledQuantityMicros: string
      readonly plannedReferenceNotionalMicros: string
      readonly executedNotionalMicros: string
      readonly executionPriceShortfallMicros: string
      readonly opportunityShortfallMicros: string
      readonly explicitCostsMicros: string
      readonly totalImplementationShortfallMicros: string
      readonly implementationShortfallRate: {
        readonly numeratorMicros: string
        readonly denominatorMicros: string
        readonly decimal: string
      }
      readonly firstDecisionAt: string
      readonly firstFillAt: string | null
      readonly lastFillAt: string | null
      readonly lastTerminalOrderObservedAt: string
    } | null
  }
  readonly observedCapacity: {
    readonly status: ForwardPerformanceMeasurementStatus
    readonly reasonCodes: readonly ForwardPerformanceObservedCapacityReasonCode[]
    readonly evidenceHash: string | null
    readonly observations: readonly {
      readonly cycleId: string
      readonly symbol: string
      readonly windowOpenedAt: string
      readonly windowClosedAt: string
      readonly filledQuantityMicros: string
      readonly marketVolumeQuantityMicros: string
      readonly participationRate: {
        readonly numeratorQuantityMicros: string
        readonly denominatorQuantityMicros: string
        readonly decimal: string
      }
    }[]
    readonly boundedObservedReferenceNotionalMicros: string | null
    readonly boundedObservedExecutedNotionalMicros: string | null
    readonly maximumParticipationRate: {
      readonly numeratorQuantityMicros: string
      readonly denominatorQuantityMicros: string
      readonly decimal: string
    } | null
  }
  readonly profitability: ForwardPerformanceProfitability
}

export interface ForwardPerformanceReceipt extends ForwardPerformanceReceiptMaterial {
  readonly receiptHash: string
}
