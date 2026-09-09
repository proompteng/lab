import { Data, Schema } from 'effect'
import type { AccountingTransaction } from '../../accounting/schema'
import { FinalizedSnapshotProvenanceSchema } from '../../contracts'
import { DiscrepancySchema, type AccountingReceipt } from '../../execution/contracts'
import { AccountingReceiptRowSchema, AccountingTransactionRowSchema } from '../../db/accounting-rows'
import {
  ImageDigestSchema,
  IsoDateSchema,
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  strictParseOptions,
} from '../../schemas'
import { CycleDecisionDocumentSchema } from '../../shadow-decision-contract'
import type {
  ForwardPerformanceCashYieldEvidence,
  ForwardPerformanceCycleEvidence,
  ForwardPerformanceExecutionEvidence,
  ForwardPerformanceMarketVolumeRequest,
  ForwardPerformanceStrategyEvidence,
  ForwardPerformanceTransactionEvidence,
} from '../model'

export const TerminalCycleRow = Schema.Struct({
  cycle_id: Sha256,
  qualification_run_id: Sha256,
  strategy_name: NonEmptyString,
  strategy_protocol_hash: Sha256,
  account_id: NonEmptyString,
  execution_policy_hash: Sha256,
  strategy_execution_model_hash: Sha256,
  state: Schema.Literals(['COMPLETED', 'NO_TRADE']),
  submission_open_at: Schema.Date,
  terminal_at: Schema.Date,
})

export const StrategyRow = Schema.Struct({
  qualification_run_id: Sha256,
  strategy_name: NonEmptyString,
  strategy_protocol_hash: Sha256,
  strategy_behavior_hash: Sha256,
  strategy_parameter_hash: Sha256,
  strategy_parameter_schema_version: NonEmptyString,
  source_revision: Schema.String,
  image_repository: NonEmptyString,
  image_digest: ImageDigestSchema,
})

export const ReconciliationRow = Schema.Struct({
  reconciliation_id: Sha256,
  content_hash: Sha256,
  status: Schema.Literals(['EXACT', 'DISCREPANCY']),
  discrepancies: Schema.Array(DiscrepancySchema),
  reconciled_at: Schema.Date,
})

export const StartingCapitalRow = Schema.Struct({ starting_capital_micros: Schema.String })
export const CashYieldEvidenceRow = Schema.Struct({
  reconciliation_id: Sha256,
  reconciliation_content_hash: Sha256,
  reconciled_at: Schema.Date,
  baseline_account_event_id: Sha256,
  baseline_observed_at: Schema.Date,
  baseline_cash_micros: Schema.String,
  opening_account_event_id: Sha256,
  opening_observed_at: Schema.Date,
  opening_cash_micros: Schema.String,
  pre_window_accounted_cash_delta_micros: Schema.String,
  pre_window_cash_residual_micros: Schema.String,
  closing_account_event_id: Sha256,
  closing_observed_at: Schema.Date,
  closing_cash_micros: Schema.String,
  accounted_cash_delta_micros: Schema.String,
  cash_yield_micros: Schema.String,
})
export const CountRow = Schema.Struct({ count: Schema.Int })
export const DurableExecutionRow = Schema.Struct({
  account_id: Schema.NullOr(NonEmptyString),
  broker_identity_hash: Schema.NullOr(Sha256),
  broker_provider: Schema.NullOr(NonEmptyString),
  broker_environment: Schema.NullOr(NonEmptyString),
  qualification_run_id: Schema.NullOr(Sha256),
  strategy_name: Schema.NullOr(NonEmptyString),
  protocol_hash: Schema.NullOr(Sha256),
  strategy_behavior_hash: Schema.NullOr(Sha256),
  strategy_parameter_hash: Schema.NullOr(Sha256),
  strategy_parameter_schema_version: Schema.NullOr(NonEmptyString),
  qualification_execution_policy_hash: Schema.NullOr(Sha256),
  qualification_source_revision: Schema.NullOr(Schema.String),
  qualification_image_repository: Schema.NullOr(NonEmptyString),
  qualification_image_digest: Schema.NullOr(ImageDigestSchema),
})
export const TransactionRow = Schema.Struct({
  ...AccountingTransactionRowSchema.fields,
  cycle_id: Schema.NullOr(Sha256),
})

export const CycleDecisionRow = Schema.Struct({
  cycle_id: Sha256,
  decision_hash: Sha256,
  document: CycleDecisionDocumentSchema,
  created_at: Schema.Date,
})
export const MarketVolumeBindingRow = Schema.Struct({
  cycle_id: Sha256,
  snapshot_id: Sha256,
  execution_session_date: IsoDateSchema,
  execution_open_at: Schema.Date,
  execution_close_at: Schema.Date,
  manifest: FinalizedSnapshotProvenanceSchema,
})
export const IntentExecutionRow = Schema.Struct({
  intent_id: Sha256,
  account_id: NonEmptyString,
  client_order_id: NonEmptyString,
  cycle_id: Sha256,
  decision_hash: Sha256,
  symbol: NonEmptyString,
  side: Schema.Literals(['BUY', 'SELL']),
  quantity_micros: Schema.String,
  notional_limit_micros: Schema.String,
  replan_generation_hash: Schema.NullOr(Sha256),
  terminal_outcome: Schema.NullOr(Schema.Literals(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'BLOCKED'])),
  created_at: Schema.Date,
  updated_at: Schema.Date,
})
export const OrderExecutionRow = Schema.Struct({
  event_id: Sha256,
  broker_order_id: NonEmptyString,
  client_order_id: NonEmptyString,
  intent_id: Sha256,
  account_id: NonEmptyString,
  symbol: NonEmptyString,
  side: Schema.Literals(['BUY', 'SELL']),
  quantity_micros: Schema.NullOr(Schema.String),
  notional_micros: Schema.NullOr(Schema.String),
  filled_quantity_micros: Schema.String,
  status: Schema.Literals(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'PENDING']),
  occurred_at: Schema.Date,
  observed_at: Schema.Date,
})
export const FillExecutionRow = Schema.Struct({
  event_id: Sha256,
  fill_id: NonEmptyString,
  broker_order_id: NonEmptyString,
  client_order_id: NonEmptyString,
  intent_id: Sha256,
  account_id: NonEmptyString,
  symbol: NonEmptyString,
  side: Schema.Literals(['BUY', 'SELL']),
  quantity_micros: Schema.String,
  price_micros: Schema.String,
  fee_micros: Schema.String,
  source_timestamp: Schema.String,
  occurred_at: Schema.Date,
  observed_at: Schema.Date,
})

export const decodeCycles = Schema.decodeUnknownEffect(Schema.Array(TerminalCycleRow), strictParseOptions)
export const decodeStrategy = Schema.decodeUnknownEffect(
  Schema.Array(StrategyRow).check(Schema.isMaxLength(1)),
  strictParseOptions,
)
export const decodeReconciliation = Schema.decodeUnknownEffect(
  Schema.Array(ReconciliationRow).check(Schema.isMaxLength(1)),
  strictParseOptions,
)
export const decodeStartingCapital = Schema.decodeUnknownEffect(
  Schema.Array(StartingCapitalRow).check(Schema.isMaxLength(1)),
  strictParseOptions,
)
export const decodeCashYieldEvidence = Schema.decodeUnknownEffect(
  Schema.Array(CashYieldEvidenceRow).check(Schema.isMaxLength(1)),
  strictParseOptions,
)
export const decodeTransactions = Schema.decodeUnknownEffect(Schema.Array(TransactionRow), strictParseOptions)
export const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(AccountingReceiptRowSchema), strictParseOptions)
export const decodeCount = Schema.decodeUnknownEffect(Schema.Tuple([CountRow]), strictParseOptions)
export const decodeDurableExecutions = Schema.decodeUnknownEffect(Schema.Array(DurableExecutionRow), strictParseOptions)
export const decodeCycleDecisions = Schema.decodeUnknownEffect(Schema.Array(CycleDecisionRow), strictParseOptions)
export const decodeMarketVolumeBindings = Schema.decodeUnknownEffect(
  Schema.Array(MarketVolumeBindingRow),
  strictParseOptions,
)
export const decodeExecutionIntents = Schema.decodeUnknownEffect(Schema.Array(IntentExecutionRow), strictParseOptions)
export const decodeExecutionOrders = Schema.decodeUnknownEffect(Schema.Array(OrderExecutionRow), strictParseOptions)
export const decodeExecutionFills = Schema.decodeUnknownEffect(Schema.Array(FillExecutionRow), strictParseOptions)

export class ForwardPerformancePostgresError extends Data.TaggedError('ForwardPerformancePostgresError')<{
  readonly operation: 'read'
  readonly failure: 'decode' | 'query'
  readonly message: string
  readonly cause: unknown
}> {}

export interface ForwardPerformancePostgresEvidence {
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
  readonly cashYieldEvidence?: ForwardPerformanceCashYieldEvidence
  readonly transactions: readonly AccountingTransaction[]
  /** All account transactions through the selected reconciliation, for stable-account ledger replay. */
  readonly ledgerTransactions: readonly AccountingTransaction[]
  readonly transactionEvidence: readonly ForwardPerformanceTransactionEvidence[]
  readonly executionEvidence: readonly ForwardPerformanceExecutionEvidence[]
  readonly marketVolumeRequests: readonly ForwardPerformanceMarketVolumeRequest[]
  readonly receipts: readonly AccountingReceipt[]
  /** All accounting receipts paired with ledgerTransactions, for stable-account ledger replay. */
  readonly ledgerReceipts: readonly AccountingReceipt[]
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
  readonly unclosedCycleCount: number
  readonly unresolvedMutationCount: number
  readonly openPositionCount: number
  readonly unaccountedFillCount: number
  readonly postReconciliationActivityCount: number
}

export const postgresError = (cause: unknown): ForwardPerformancePostgresError =>
  new ForwardPerformancePostgresError({
    operation: 'read',
    failure: Schema.isSchemaError(cause) ? 'decode' : 'query',
    message: 'forward-performance PostgreSQL read failed',
    cause,
  })
