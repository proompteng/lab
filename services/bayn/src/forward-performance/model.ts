export const FORWARD_PERFORMANCE_SCHEMA_VERSION = 'bayn.forward-performance-receipt.v2' as const

export type ForwardPerformanceEvidenceStatus = 'SUFFICIENT' | 'INSUFFICIENT_EVIDENCE'
export type ForwardPerformanceProfitability = 'PROFITABLE' | 'NOT_PROFITABLE' | 'UNDETERMINED'

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
  readonly cycleId: string
  readonly side: 'BUY' | 'SELL'
  readonly feeMicros: string
  readonly realizedPnlMicros: string
  readonly occurredAt: string
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
  readonly profitability: ForwardPerformanceProfitability
}

export interface ForwardPerformanceReceipt extends ForwardPerformanceReceiptMaterial {
  readonly receiptHash: string
}
