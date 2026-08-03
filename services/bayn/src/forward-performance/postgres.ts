import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Schema } from 'effect'

import type { AccountingTransaction } from '../accounting/schema'
import { FinalizedSnapshotProvenanceSchema } from '../contracts'
import {
  decodeAccountingReceipt,
  DiscrepancyKind,
  DiscrepancySchema,
  type AccountingReceipt,
} from '../execution/contracts'
import {
  AccountingReceiptRowSchema,
  AccountingTransactionRowSchema,
  accountingReceiptFromRow,
  accountingTransactionFromRow,
} from '../db/accounting-rows'
import {
  ImageDigestSchema,
  IsoDateSchema,
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  strictParseOptions,
} from '../schemas'
import { CycleDecisionDocumentSchema } from '../shadow-decision-contract'
import type {
  ForwardPerformanceCashYieldEvidence,
  ForwardPerformanceCycleEvidence,
  ForwardPerformanceExecutionEvidence,
  ForwardPerformanceMarketVolumeRequest,
  ForwardPerformanceStrategyEvidence,
  ForwardPerformanceTransactionEvidence,
} from './model'

const TerminalCycleRow = Schema.Struct({
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

const StrategyRow = Schema.Struct({
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

const ReconciliationRow = Schema.Struct({
  reconciliation_id: Sha256,
  content_hash: Sha256,
  status: Schema.Literals(['EXACT', 'DISCREPANCY']),
  discrepancies: Schema.Array(DiscrepancySchema),
  reconciled_at: Schema.Date,
})

const StartingCapitalRow = Schema.Struct({ starting_capital_micros: Schema.String })
const CashYieldEvidenceRow = Schema.Struct({
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
const CountRow = Schema.Struct({ count: Schema.Int })
const DurableExecutionRow = Schema.Struct({
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
const TransactionRow = Schema.Struct({
  ...AccountingTransactionRowSchema.fields,
  cycle_id: Schema.NullOr(Sha256),
})

const CycleDecisionRow = Schema.Struct({
  cycle_id: Sha256,
  decision_hash: Sha256,
  document: CycleDecisionDocumentSchema,
  created_at: Schema.Date,
})
const MarketVolumeBindingRow = Schema.Struct({
  cycle_id: Sha256,
  snapshot_id: Sha256,
  execution_session_date: IsoDateSchema,
  execution_open_at: Schema.Date,
  execution_close_at: Schema.Date,
  manifest: FinalizedSnapshotProvenanceSchema,
})
const IntentExecutionRow = Schema.Struct({
  intent_id: Sha256,
  account_id: NonEmptyString,
  client_order_id: NonEmptyString,
  cycle_id: Sha256,
  decision_hash: Sha256,
  symbol: NonEmptyString,
  side: Schema.Literals(['BUY', 'SELL']),
  quantity_micros: Schema.String,
  terminal_outcome: Schema.NullOr(Schema.Literals(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'BLOCKED'])),
  created_at: Schema.Date,
  updated_at: Schema.Date,
})
const OrderExecutionRow = Schema.Struct({
  event_id: Sha256,
  broker_order_id: NonEmptyString,
  client_order_id: NonEmptyString,
  intent_id: Sha256,
  account_id: NonEmptyString,
  symbol: NonEmptyString,
  side: Schema.Literals(['BUY', 'SELL']),
  quantity_micros: Schema.String,
  filled_quantity_micros: Schema.String,
  status: Schema.Literals(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'PENDING']),
  occurred_at: Schema.Date,
  observed_at: Schema.Date,
})
const FillExecutionRow = Schema.Struct({
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

const decodeCycles = Schema.decodeUnknownEffect(Schema.Array(TerminalCycleRow), strictParseOptions)
const decodeStrategy = Schema.decodeUnknownEffect(
  Schema.Array(StrategyRow).check(Schema.isMaxLength(1)),
  strictParseOptions,
)
const decodeReconciliation = Schema.decodeUnknownEffect(
  Schema.Array(ReconciliationRow).check(Schema.isMaxLength(1)),
  strictParseOptions,
)
const decodeStartingCapital = Schema.decodeUnknownEffect(
  Schema.Array(StartingCapitalRow).check(Schema.isMaxLength(1)),
  strictParseOptions,
)
const decodeCashYieldEvidence = Schema.decodeUnknownEffect(
  Schema.Array(CashYieldEvidenceRow).check(Schema.isMaxLength(1)),
  strictParseOptions,
)
const decodeTransactions = Schema.decodeUnknownEffect(Schema.Array(TransactionRow), strictParseOptions)
const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(AccountingReceiptRowSchema), strictParseOptions)
const decodeCount = Schema.decodeUnknownEffect(Schema.Tuple([CountRow]), strictParseOptions)
const decodeDurableExecutions = Schema.decodeUnknownEffect(Schema.Array(DurableExecutionRow), strictParseOptions)
const decodeCycleDecisions = Schema.decodeUnknownEffect(Schema.Array(CycleDecisionRow), strictParseOptions)
const decodeMarketVolumeBindings = Schema.decodeUnknownEffect(Schema.Array(MarketVolumeBindingRow), strictParseOptions)
const decodeExecutionIntents = Schema.decodeUnknownEffect(Schema.Array(IntentExecutionRow), strictParseOptions)
const decodeExecutionOrders = Schema.decodeUnknownEffect(Schema.Array(OrderExecutionRow), strictParseOptions)
const decodeExecutionFills = Schema.decodeUnknownEffect(Schema.Array(FillExecutionRow), strictParseOptions)

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
  readonly transactionEvidence: readonly ForwardPerformanceTransactionEvidence[]
  readonly executionEvidence: readonly ForwardPerformanceExecutionEvidence[]
  readonly marketVolumeRequests: readonly ForwardPerformanceMarketVolumeRequest[]
  readonly receipts: readonly AccountingReceipt[]
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

const postgresError = (cause: unknown): ForwardPerformancePostgresError =>
  new ForwardPerformancePostgresError({
    operation: 'read',
    failure: Schema.isSchemaError(cause) ? 'decode' : 'query',
    message: 'forward-performance PostgreSQL read failed',
    cause,
  })

const SIGNED_I128_MIN = -(1n << 127n)
const SIGNED_I128_MAX = (1n << 127n) - 1n
const INTEGER_PATTERN = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/

type GenerationScopeTarget =
  | 'cycle'
  | 'intent'
  | 'transaction'
  | 'reconciliation'
  | 'snapshot'
  | 'opening-snapshot'
  | 'order'
  | 'fill'
  | 'mutation'

const generationScope = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash: string | undefined,
  target: GenerationScopeTarget,
) => {
  if (authorityGenerationHash === undefined) return true

  switch (target) {
    case 'cycle':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND scope_generation.qualification_run_id = cycle.qualification_run_id
          AND (
            EXISTS (
              SELECT 1
              FROM autonomous_cycle_shadow_decisions AS scoped_decision
              WHERE scoped_decision.cycle_id = cycle.cycle_id
                AND scoped_decision.decision_hash = cycle.decision_hash
                AND scoped_decision.schema_version = 'bayn.paper-cycle-decision.v1'
                AND scoped_decision.document ->> 'mode' = 'PAPER'
                AND scoped_decision.document #>> '{bindings,accountId}' = scope_generation.account_id
                AND scoped_decision.document #>> '{bindings,qualificationRunId}' = cycle.qualification_run_id
                AND scoped_decision.document #>> '{bindings,authorityGenerationHash}' = scope_generation.generation_hash
            )
            OR EXISTS (
              SELECT 1
              FROM intents AS scoped_intent
              WHERE scoped_intent.cycle_id = cycle.cycle_id
                AND scoped_intent.account_id = scope_generation.account_id
                AND scoped_intent.authority_generation_hash = scope_generation.generation_hash
            )
          )
      )`
    case 'intent':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        LEFT JOIN authority_generations AS next_generation
          ON next_generation.previous_generation_hash = scope_generation.generation_hash
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND intent.account_id = scope_generation.account_id
          AND intent.authority_generation_hash = scope_generation.generation_hash
          AND intent.created_at >= scope_generation.activated_at
          AND (
            next_generation.activated_at IS NULL
            OR intent.created_at < next_generation.activated_at
          )
      )`
    case 'transaction':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        JOIN intents AS scope_intent
          ON scope_intent.intent_id = transaction.intent_id
          AND scope_intent.account_id = transaction.account_id
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND transaction.account_id = scope_generation.account_id
          AND scope_intent.authority_generation_hash = scope_generation.generation_hash
      )`
    case 'reconciliation':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        LEFT JOIN authority_generations AS next_generation
          ON next_generation.previous_generation_hash = scope_generation.generation_hash
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND reconciliation.account_id = scope_generation.account_id
          AND reconciliation.reconciled_at >= scope_generation.activated_at
          AND (
            next_generation.activated_at IS NULL
            OR reconciliation.reconciled_at < next_generation.activated_at
          )
      )`
    case 'snapshot':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        LEFT JOIN authority_generations AS next_generation
          ON next_generation.previous_generation_hash = scope_generation.generation_hash
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND snapshot.account_id = scope_generation.account_id
          AND event.observed_at >= scope_generation.activated_at
          AND (
            next_generation.activated_at IS NULL
            OR event.observed_at < next_generation.activated_at
          )
      )`
    case 'opening-snapshot':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
      )`
    case 'order':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        JOIN intents AS scope_intent
          ON scope_intent.intent_id = observed_order.intent_id
          AND scope_intent.account_id = observed_order.account_id
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND scope_intent.authority_generation_hash = scope_generation.generation_hash
      )`
    case 'fill':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        JOIN intents AS scope_intent
          ON scope_intent.intent_id = fill.intent_id
          AND scope_intent.account_id = fill.account_id
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND scope_intent.authority_generation_hash = scope_generation.generation_hash
      )`
    case 'mutation':
      return sql`EXISTS (
        SELECT 1
        FROM authority_generations AS scope_generation
        JOIN intents AS scope_intent
          ON scope_intent.intent_id = event.intent_id
          AND scope_intent.account_id = ${accountId}
        WHERE scope_generation.generation_hash = ${authorityGenerationHash}
          AND scope_generation.maximum = 'PAPER'
          AND scope_generation.account_id = ${accountId}
          AND scope_intent.authority_generation_hash = scope_generation.generation_hash
      )`
  }
}

const openingSnapshotBoundary = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash: string | undefined,
) =>
  authorityGenerationHash === undefined
    ? sql`first_cycle.submission_open_at`
    : sql`GREATEST(
        first_cycle.submission_open_at,
        (
          SELECT scope_generation.activated_at
          FROM authority_generations AS scope_generation
          WHERE scope_generation.generation_hash = ${authorityGenerationHash}
            AND scope_generation.maximum = 'PAPER'
            AND scope_generation.account_id = ${accountId}
        )
      )`

const signedI128 = (value: string): bigint | undefined => {
  if (!INTEGER_PATTERN.test(value)) return undefined
  const parsed = BigInt(value)
  return parsed < SIGNED_I128_MIN || parsed > SIGNED_I128_MAX ? undefined : parsed
}

const reconciliationExactness = (
  accountId: string,
  reconciliation: typeof ReconciliationRow.Type,
  cashYield: typeof CashYieldEvidenceRow.Type | undefined,
): { readonly performanceExact: boolean; readonly cashYieldAdjustedExact: boolean } => {
  if (reconciliation.status === 'EXACT') {
    return {
      performanceExact: reconciliation.discrepancies.length === 0,
      cashYieldAdjustedExact: false,
    }
  }
  const discrepancy = reconciliation.discrepancies[0]
  if (
    cashYield === undefined ||
    reconciliation.discrepancies.length !== 1 ||
    discrepancy === undefined ||
    discrepancy.kind !== DiscrepancyKind.Cash ||
    discrepancy.identity !== accountId ||
    discrepancy.lastObservedAt !== reconciliation.reconciled_at.toISOString() ||
    cashYield.reconciliation_id !== reconciliation.reconciliation_id ||
    cashYield.reconciliation_content_hash !== reconciliation.content_hash ||
    cashYield.reconciled_at.toISOString() !== reconciliation.reconciled_at.toISOString()
  ) {
    return { performanceExact: false, cashYieldAdjustedExact: false }
  }

  const baselineCash = signedI128(cashYield.baseline_cash_micros)
  const openingCash = signedI128(cashYield.opening_cash_micros)
  const preWindowCashDelta = signedI128(cashYield.pre_window_accounted_cash_delta_micros)
  const preWindowResidual = signedI128(cashYield.pre_window_cash_residual_micros)
  const closingCash = signedI128(cashYield.closing_cash_micros)
  const accountedCashDelta = signedI128(cashYield.accounted_cash_delta_micros)
  const yieldAmount = signedI128(cashYield.cash_yield_micros)
  const expectedCash = signedI128(discrepancy.expected)
  const observedCash = signedI128(discrepancy.observed)
  if (
    baselineCash === undefined ||
    openingCash === undefined ||
    preWindowCashDelta === undefined ||
    preWindowResidual === undefined ||
    closingCash === undefined ||
    accountedCashDelta === undefined ||
    yieldAmount === undefined ||
    expectedCash === undefined ||
    observedCash === undefined ||
    yieldAmount <= 0n ||
    preWindowResidual !== 0n ||
    openingCash !== baselineCash + preWindowCashDelta ||
    expectedCash !== openingCash + accountedCashDelta ||
    observedCash !== closingCash ||
    observedCash - expectedCash !== yieldAmount ||
    closingCash - openingCash - accountedCashDelta !== yieldAmount
  ) {
    return { performanceExact: false, cashYieldAdjustedExact: false }
  }

  return { performanceExact: true, cashYieldAdjustedExact: true }
}

const transactionQuery = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash: string | undefined,
) => sql<Record<string, unknown>>`
  WITH latest_reconciliation AS (
    SELECT reconciliation.reconciled_at
    FROM reconciliations AS reconciliation
    WHERE reconciliation.account_id = ${accountId}
      AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
    ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
    LIMIT 1
  ), first_cycle AS (
    SELECT cycle.submission_open_at
    FROM autonomous_cycles AS cycle
    WHERE cycle.account_id = ${accountId}
      AND cycle.state IN ('COMPLETED', 'NO_TRADE')
      AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
    ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
    LIMIT 1
  ), opening_snapshot AS (
    SELECT event.observed_at
    FROM account_snapshots AS snapshot
    JOIN broker_events AS event ON event.event_id = snapshot.event_id
    CROSS JOIN latest_reconciliation
    CROSS JOIN first_cycle
    WHERE snapshot.account_id = ${accountId}
      AND ${generationScope(sql, accountId, authorityGenerationHash, 'opening-snapshot')}
      AND event.observed_at <= ${openingSnapshotBoundary(sql, accountId, authorityGenerationHash)}
      AND event.observed_at <= latest_reconciliation.reconciled_at
    ORDER BY event.observed_at DESC, event.source_sequence DESC, event.event_id COLLATE "C" DESC
    LIMIT 1
  )
  SELECT
    transaction.schema_version,
    transaction.transaction_id,
    transaction.broker_event_id,
    transaction.intent_id,
    transaction.account_id,
    transaction.symbol,
    transaction.side,
    transaction.quantity_micros::text AS quantity_micros,
    transaction.price_micros::text AS price_micros,
    transaction.notional_micros::text AS notional_micros,
    transaction.fee_micros::text AS fee_micros,
    transaction.cost_basis_micros::text AS cost_basis_micros,
    transaction.realized_pnl_micros::text AS realized_pnl_micros,
    transaction.quantity_delta_micros::text AS quantity_delta_micros,
    transaction.cost_basis_delta_micros::text AS cost_basis_delta_micros,
    transaction.cash_delta_micros::text AS cash_delta_micros,
    transaction.ledger_plan_hash,
    transaction.content_hash,
    transaction.occurred_at,
    intent.cycle_id
  FROM accounting_transactions AS transaction
  CROSS JOIN latest_reconciliation
  CROSS JOIN opening_snapshot
  LEFT JOIN intents AS intent ON intent.intent_id = transaction.intent_id
  WHERE transaction.account_id = ${accountId}
    AND transaction.occurred_at >= opening_snapshot.observed_at
    AND transaction.occurred_at <= latest_reconciliation.reconciled_at
    AND ${generationScope(sql, accountId, authorityGenerationHash, 'transaction')}
  ORDER BY transaction.occurred_at, transaction.transaction_id COLLATE "C"
`

const receiptQuery = (sql: PgClient.PgClient, accountId: string, authorityGenerationHash: string | undefined) => sql<
  Record<string, unknown>
>`
  WITH latest_reconciliation AS (
    SELECT reconciliation.reconciled_at
    FROM reconciliations AS reconciliation
    WHERE reconciliation.account_id = ${accountId}
      AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
    ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
    LIMIT 1
  ), first_cycle AS (
    SELECT cycle.submission_open_at
    FROM autonomous_cycles AS cycle
    WHERE cycle.account_id = ${accountId}
      AND cycle.state IN ('COMPLETED', 'NO_TRADE')
      AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
    ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
    LIMIT 1
  ), opening_snapshot AS (
    SELECT event.observed_at
    FROM account_snapshots AS snapshot
    JOIN broker_events AS event ON event.event_id = snapshot.event_id
    CROSS JOIN latest_reconciliation
    CROSS JOIN first_cycle
    WHERE snapshot.account_id = ${accountId}
      AND ${generationScope(sql, accountId, authorityGenerationHash, 'opening-snapshot')}
      AND event.observed_at <= ${openingSnapshotBoundary(sql, accountId, authorityGenerationHash)}
      AND event.observed_at <= latest_reconciliation.reconciled_at
    ORDER BY event.observed_at DESC, event.source_sequence DESC, event.event_id COLLATE "C" DESC
    LIMIT 1
  ), selected_transactions AS (
    SELECT broker_event_id
    FROM accounting_transactions AS transaction
    CROSS JOIN latest_reconciliation
    CROSS JOIN opening_snapshot
    WHERE transaction.account_id = ${accountId}
      AND transaction.occurred_at >= opening_snapshot.observed_at
      AND transaction.occurred_at <= latest_reconciliation.reconciled_at
      AND ${generationScope(sql, accountId, authorityGenerationHash, 'transaction')}
  )
  SELECT
    receipt.schema_version,
    receipt.receipt_id,
    receipt.intent_id,
    receipt.broker_event_id,
    receipt.tigerbeetle_cluster_id::text AS tigerbeetle_cluster_id,
    receipt.tigerbeetle_ledger::integer AS tigerbeetle_ledger,
    ARRAY(
      SELECT item.value::text FROM unnest(receipt.account_ids) AS item(value) ORDER BY item.value
    ) AS account_ids,
    ARRAY(
      SELECT item.value::text FROM unnest(receipt.transfer_ids) AS item(value) ORDER BY item.value
    ) AS transfer_ids,
    receipt.debit_micros::text AS debit_micros,
    receipt.credit_micros::text AS credit_micros,
    receipt.content_hash,
    receipt.recorded_at
  FROM accounting_receipts AS receipt
  JOIN selected_transactions USING (broker_event_id)
  ORDER BY receipt.broker_event_id COLLATE "C"
`

const uniqueRows = <Row>(rows: readonly Row[], key: (row: Row) => string): ReadonlyMap<string, Row | null> => {
  const byKey = new Map<string, Row | null>()
  for (const row of rows) {
    const identity = key(row)
    byKey.set(identity, byKey.has(identity) ? null : row)
  }
  return byKey
}

const intentExecutionKey = (input: {
  readonly cycleId: string
  readonly decisionHash: string
  readonly accountId: string
  readonly symbol: string
  readonly side: 'BUY' | 'SELL'
  readonly quantityMicros: string
  readonly createdAt: string
}): string =>
  JSON.stringify([
    input.cycleId,
    input.decisionHash,
    input.accountId,
    input.symbol,
    input.side,
    input.quantityMicros,
    input.createdAt,
  ])

const executionEvidenceFromRows = (
  decisionRows: readonly (typeof CycleDecisionRow.Type)[],
  intentRows: readonly (typeof IntentExecutionRow.Type)[],
  orderRows: readonly (typeof OrderExecutionRow.Type)[],
  fillRows: readonly (typeof FillExecutionRow.Type)[],
): readonly ForwardPerformanceExecutionEvidence[] => {
  const intents = uniqueRows(intentRows, (row) =>
    intentExecutionKey({
      cycleId: row.cycle_id,
      decisionHash: row.decision_hash,
      accountId: row.account_id,
      symbol: row.symbol,
      side: row.side,
      quantityMicros: row.quantity_micros,
      createdAt: row.created_at.toISOString(),
    }),
  )
  const orders = uniqueRows(orderRows, (row) => row.intent_id)
  const fills = new Map<string, (typeof FillExecutionRow.Type)[]>()
  for (const row of fillRows) {
    const found = fills.get(row.intent_id)
    if (found === undefined) fills.set(row.intent_id, [row])
    else found.push(row)
  }

  const evidence: ForwardPerformanceExecutionEvidence[] = []
  for (const row of decisionRows) {
    const document = row.document
    if (document.targetPlan.status !== 'PLANNED') continue
    for (const target of document.targetPlan.intentTargets) {
      const matchingReferences = document.targetPlan.targets.filter((candidate) => candidate.symbol === target.symbol)
      const reference = matchingReferences.length === 1 ? matchingReferences[0] : undefined
      const intentRow = intents.get(
        intentExecutionKey({
          cycleId: row.cycle_id,
          decisionHash: document.bindings.strategyDecisionHash,
          accountId: document.bindings.accountId,
          symbol: target.symbol,
          side: target.side,
          quantityMicros: target.quantityMicros,
          createdAt: document.createdAt,
        }),
      )
      const intentId = intentRow === undefined || intentRow === null ? '' : intentRow.intent_id
      const orderRow = orders.get(intentId)
      const fillEvidence = (fills.get(intentId) ?? []).map((fill) => ({
        brokerEventId: fill.event_id,
        fillId: fill.fill_id,
        brokerOrderId: fill.broker_order_id,
        clientOrderId: fill.client_order_id,
        intentId: fill.intent_id,
        accountId: fill.account_id,
        symbol: fill.symbol,
        side: fill.side,
        quantityMicros: fill.quantity_micros,
        priceMicros: fill.price_micros,
        feeMicros: fill.fee_micros,
        sourceTimestamp: fill.source_timestamp,
        occurredAt: fill.occurred_at.toISOString(),
        observedAt: fill.observed_at.toISOString(),
      }))
      evidence.push({
        cycleId: row.cycle_id,
        decisionDocumentHash:
          row.decision_hash === document.contentHash &&
          document.bindings.cycleId === row.cycle_id &&
          document.createdAt === row.created_at.toISOString()
            ? document.contentHash
            : '',
        decisionHash: document.bindings.strategyDecisionHash,
        decisionCreatedAt: document.createdAt,
        intentId,
        accountId: document.bindings.accountId,
        symbol: target.symbol,
        side: target.side,
        plannedQuantityMicros: target.quantityMicros,
        ...(reference === undefined ? {} : { referencePriceMicros: reference.referencePriceMicros }),
        ...(intentRow === undefined || intentRow === null || intentRow.terminal_outcome === null
          ? {}
          : {
              intent: {
                intentId: intentRow.intent_id,
                accountId: intentRow.account_id,
                clientOrderId: intentRow.client_order_id,
                cycleId: intentRow.cycle_id,
                decisionHash: intentRow.decision_hash,
                symbol: intentRow.symbol,
                side: intentRow.side,
                quantityMicros: intentRow.quantity_micros,
                terminalOutcome: intentRow.terminal_outcome,
                createdAt: intentRow.created_at.toISOString(),
                updatedAt: intentRow.updated_at.toISOString(),
              },
            }),
        ...(orderRow === undefined || orderRow === null
          ? {}
          : {
              terminalOrder: {
                eventId: orderRow.event_id,
                brokerOrderId: orderRow.broker_order_id,
                clientOrderId: orderRow.client_order_id,
                intentId: orderRow.intent_id,
                accountId: orderRow.account_id,
                symbol: orderRow.symbol,
                side: orderRow.side,
                quantityMicros: orderRow.quantity_micros,
                filledQuantityMicros: orderRow.filled_quantity_micros,
                status: orderRow.status,
                occurredAt: orderRow.occurred_at.toISOString(),
                observedAt: orderRow.observed_at.toISOString(),
              },
            }),
        fills: fillEvidence,
      })
    }
  }
  return evidence
}

const marketVolumeRequestsFromRows = (
  executionEvidence: readonly ForwardPerformanceExecutionEvidence[],
  bindingRows: readonly (typeof MarketVolumeBindingRow.Type)[],
  evidenceCutoffAt: string | undefined,
): readonly ForwardPerformanceMarketVolumeRequest[] => {
  if (evidenceCutoffAt === undefined) return []
  const bindings = uniqueRows(bindingRows, (row) => row.cycle_id)
  const requests = new Map<string, ForwardPerformanceMarketVolumeRequest>()
  for (const execution of executionEvidence) {
    const binding = bindings.get(execution.cycleId)
    if (
      binding === undefined ||
      binding === null ||
      binding.snapshot_id !== binding.manifest.snapshotId ||
      !binding.manifest.symbols.includes(execution.symbol)
    ) {
      continue
    }
    const request: ForwardPerformanceMarketVolumeRequest = {
      cycleId: execution.cycleId,
      decisionSnapshotId: binding.snapshot_id,
      decisionSnapshotAsOfSession: binding.manifest.asOfSession,
      symbol: execution.symbol,
      executionSessionDate: binding.execution_session_date,
      windowOpenedAt: binding.execution_open_at.toISOString(),
      windowClosedAt: binding.execution_close_at.toISOString(),
      evidenceCutoffAt,
      universeId: binding.manifest.universeId,
      universeSymbolHash: binding.manifest.universeSymbolHash,
      symbols: binding.manifest.symbols,
      requestedStart: binding.manifest.requestedStart,
      calendarVersion: binding.manifest.calendarVersion,
      source: binding.manifest.source,
      sourceFeed: binding.manifest.sourceFeed,
      adjustment: binding.manifest.adjustment,
    }
    requests.set(JSON.stringify([request.cycleId, request.symbol]), request)
  }
  return [...requests.values()].sort((left, right) => {
    const leftKey = JSON.stringify([left.executionSessionDate, left.cycleId, left.symbol])
    const rightKey = JSON.stringify([right.executionSessionDate, right.cycleId, right.symbol])
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

export const readForwardPerformancePostgres = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash?: string,
): Effect.Effect<ForwardPerformancePostgresEvidence, ForwardPerformancePostgresError> =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`

        const cycleRows = yield* sql<Record<string, unknown>>`
          SELECT
            cycle_id,
            qualification_run_id,
            strategy_name,
            strategy_protocol_hash,
            account_id,
            execution_policy_hash,
            strategy_execution_model_hash,
            state,
            submission_open_at,
            terminal_at
          FROM autonomous_cycles AS cycle
          WHERE cycle.account_id = ${accountId}
            AND cycle.state IN ('COMPLETED', 'NO_TRADE')
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
          ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeCycles))

        const strategyRows = yield* sql<Record<string, unknown>>`
          WITH first_cycle AS (
            SELECT qualification_run_id, strategy_protocol_hash
            FROM autonomous_cycles AS cycle
            WHERE cycle.account_id = ${accountId}
              AND cycle.state IN ('COMPLETED', 'NO_TRADE')
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
            ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
            LIMIT 1
          )
          SELECT
            evaluation.run_id AS qualification_run_id,
            evaluation.strategy_name,
            protocol.protocol_hash AS strategy_protocol_hash,
            protocol.behavior_hash AS strategy_behavior_hash,
            protocol.parameter_hash AS strategy_parameter_hash,
            protocol.schema_version AS strategy_parameter_schema_version,
            evaluation.source_revision,
            evaluation.image_repository,
            evaluation.image_digest
          FROM first_cycle
          JOIN qualification_results AS result
            ON result.run_id = first_cycle.qualification_run_id
            AND result.verdict = 'QUALIFIED'
          JOIN qualification_locks AS qualification_lock ON qualification_lock.lock_id = result.lock_id
          JOIN evaluation_runs AS evaluation ON evaluation.run_id = result.run_id
          JOIN protocol_locks AS protocol
            ON protocol.protocol_hash = first_cycle.strategy_protocol_hash
            AND protocol.protocol_hash = qualification_lock.protocol_hash
            AND protocol.protocol_hash = evaluation.protocol_hash
          WHERE evaluation.status = 'COMPLETE'
            AND qualification_lock.source_revision = evaluation.source_revision
            AND qualification_lock.image_repository = evaluation.image_repository
            AND qualification_lock.image_digest = evaluation.image_digest
        `.pipe(Effect.flatMap(decodeStrategy))

        const reconciliationRows = yield* sql<Record<string, unknown>>`
          SELECT reconciliation_id, content_hash, status, discrepancies, reconciled_at
          FROM reconciliations AS reconciliation
          WHERE reconciliation.account_id = ${accountId}
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
          ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
          LIMIT 1
        `.pipe(Effect.flatMap(decodeReconciliation))

        const startingCapitalRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          ), first_cycle AS (
            SELECT cycle.submission_open_at
            FROM autonomous_cycles AS cycle
            WHERE cycle.account_id = ${accountId}
              AND cycle.state IN ('COMPLETED', 'NO_TRADE')
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
            ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
            LIMIT 1
          )
          SELECT snapshot.equity_micros::text AS starting_capital_micros
          FROM account_snapshots AS snapshot
          JOIN broker_events AS event ON event.event_id = snapshot.event_id
          CROSS JOIN latest_reconciliation
          CROSS JOIN first_cycle
          WHERE snapshot.account_id = ${accountId}
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'opening-snapshot')}
            AND event.observed_at <= ${openingSnapshotBoundary(sql, accountId, authorityGenerationHash)}
            AND event.observed_at <= latest_reconciliation.reconciled_at
          ORDER BY event.observed_at DESC, event.source_sequence DESC, event.event_id COLLATE "C" DESC
          LIMIT 1
        `.pipe(Effect.flatMap(decodeStartingCapital))

        const cashYieldRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation_id, content_hash, reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          ), first_cycle AS (
            SELECT cycle.submission_open_at
            FROM autonomous_cycles AS cycle
            WHERE cycle.account_id = ${accountId}
              AND cycle.state IN ('COMPLETED', 'NO_TRADE')
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
            ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
            LIMIT 1
          ), baseline_snapshot AS (
            SELECT
              event.event_id,
              event.observed_at,
              snapshot.cash_micros
            FROM account_snapshots AS snapshot
            JOIN broker_events AS event ON event.event_id = snapshot.event_id
            WHERE snapshot.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'snapshot')}
            ORDER BY event.source_sequence, event.event_id COLLATE "C"
            LIMIT 1
          ), opening_snapshot AS (
            SELECT
              event.event_id,
              event.observed_at,
              snapshot.cash_micros
            FROM account_snapshots AS snapshot
            JOIN broker_events AS event ON event.event_id = snapshot.event_id
            CROSS JOIN latest_reconciliation
            CROSS JOIN first_cycle
            WHERE snapshot.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'opening-snapshot')}
              AND event.observed_at <= ${openingSnapshotBoundary(sql, accountId, authorityGenerationHash)}
              AND event.observed_at <= latest_reconciliation.reconciled_at
            ORDER BY event.observed_at DESC, event.source_sequence DESC, event.event_id COLLATE "C" DESC
            LIMIT 1
          ), pre_window_accounted_cash AS (
            SELECT COALESCE(sum(transaction.cash_delta_micros), 0) AS cash_delta_micros
            FROM accounting_transactions AS transaction
            CROSS JOIN opening_snapshot
            WHERE transaction.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'transaction')}
              AND transaction.occurred_at < opening_snapshot.observed_at
          ), closing_snapshot AS (
            SELECT
              event.event_id,
              event.observed_at,
              snapshot.cash_micros
            FROM account_snapshots AS snapshot
            JOIN broker_events AS event ON event.event_id = snapshot.event_id
            CROSS JOIN latest_reconciliation
            WHERE snapshot.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'snapshot')}
              AND event.observed_at <= latest_reconciliation.reconciled_at
            ORDER BY event.observed_at DESC, event.source_sequence DESC, event.event_id COLLATE "C" DESC
            LIMIT 1
          ), accounted_cash AS (
            SELECT COALESCE(sum(transaction.cash_delta_micros), 0) AS cash_delta_micros
            FROM accounting_transactions AS transaction
            CROSS JOIN latest_reconciliation
            CROSS JOIN opening_snapshot
            WHERE transaction.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'transaction')}
              AND transaction.occurred_at >= opening_snapshot.observed_at
              AND transaction.occurred_at <= latest_reconciliation.reconciled_at
          )
          SELECT
            latest_reconciliation.reconciliation_id,
            latest_reconciliation.content_hash AS reconciliation_content_hash,
            latest_reconciliation.reconciled_at,
            baseline_snapshot.event_id AS baseline_account_event_id,
            baseline_snapshot.observed_at AS baseline_observed_at,
            baseline_snapshot.cash_micros::text AS baseline_cash_micros,
            opening_snapshot.event_id AS opening_account_event_id,
            opening_snapshot.observed_at AS opening_observed_at,
            opening_snapshot.cash_micros::text AS opening_cash_micros,
            pre_window_accounted_cash.cash_delta_micros::text AS pre_window_accounted_cash_delta_micros,
            (
              opening_snapshot.cash_micros
              - baseline_snapshot.cash_micros
              - pre_window_accounted_cash.cash_delta_micros
            )::text AS pre_window_cash_residual_micros,
            closing_snapshot.event_id AS closing_account_event_id,
            closing_snapshot.observed_at AS closing_observed_at,
            closing_snapshot.cash_micros::text AS closing_cash_micros,
            accounted_cash.cash_delta_micros::text AS accounted_cash_delta_micros,
            (
              closing_snapshot.cash_micros
              - opening_snapshot.cash_micros
              - accounted_cash.cash_delta_micros
            )::text AS cash_yield_micros
          FROM latest_reconciliation
          CROSS JOIN baseline_snapshot
          CROSS JOIN opening_snapshot
          CROSS JOIN pre_window_accounted_cash
          CROSS JOIN closing_snapshot
          CROSS JOIN accounted_cash
        `.pipe(Effect.flatMap(decodeCashYieldEvidence))

        const transactionRows = yield* transactionQuery(sql, accountId, authorityGenerationHash).pipe(
          Effect.flatMap(decodeTransactions),
        )
        const receiptRows = yield* receiptQuery(sql, accountId, authorityGenerationHash).pipe(
          Effect.flatMap(decodeReceipts),
        )
        const receipts = yield* Effect.forEach(receiptRows, (row) =>
          decodeAccountingReceipt(accountingReceiptFromRow(row)),
        )
        const cycleDecisionRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT
            cycle.cycle_id,
            decision.decision_hash,
            decision.document,
            decision.created_at
          FROM autonomous_cycles AS cycle
          JOIN autonomous_cycle_shadow_decisions AS decision
            ON decision.cycle_id = cycle.cycle_id
            AND decision.decision_hash = cycle.decision_hash
          CROSS JOIN latest_reconciliation
          WHERE cycle.account_id = ${accountId}
            AND cycle.state = 'COMPLETED'
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
            AND cycle.terminal_at <= latest_reconciliation.reconciled_at
            AND decision.schema_version IN ('bayn.observe-shadow-decision.v1', 'bayn.paper-cycle-decision.v1')
          ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeCycleDecisions))
        const marketVolumeBindingRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT
            cycle.cycle_id,
            cycle.snapshot_id,
            cycle.execution_session_date::text AS execution_session_date,
            cycle.execution_open_at,
            cycle.execution_close_at,
            reference.manifest
          FROM autonomous_cycles AS cycle
          JOIN snapshot_references AS reference ON reference.snapshot_id = cycle.snapshot_id
          CROSS JOIN latest_reconciliation
          WHERE cycle.account_id = ${accountId}
            AND cycle.state = 'COMPLETED'
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
            AND cycle.terminal_at <= latest_reconciliation.reconciled_at
          ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeMarketVolumeBindings))
        const executionIntentRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT
            intent.intent_id,
            intent.account_id,
            intent.client_order_id,
            intent.cycle_id,
            intent.decision_hash,
            intent.symbol,
            intent.side,
            intent.quantity_micros::text AS quantity_micros,
            intent.terminal_outcome,
            intent.created_at,
            intent.updated_at
          FROM intents AS intent
          JOIN autonomous_cycles AS cycle ON cycle.cycle_id = intent.cycle_id
          CROSS JOIN latest_reconciliation
          WHERE intent.account_id = ${accountId}
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'intent')}
            AND cycle.account_id = ${accountId}
            AND cycle.state = 'COMPLETED'
            AND cycle.terminal_at <= latest_reconciliation.reconciled_at
          ORDER BY intent.cycle_id COLLATE "C", intent.intent_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeExecutionIntents))
        const executionOrderRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT DISTINCT ON (observed_order.intent_id)
            event.event_id,
            observed_order.broker_order_id,
            observed_order.client_order_id,
            observed_order.intent_id,
            observed_order.account_id,
            observed_order.symbol,
            observed_order.side,
            observed_order.quantity_micros::text AS quantity_micros,
            observed_order.filled_quantity_micros::text AS filled_quantity_micros,
            observed_order.status,
            event.occurred_at,
            event.observed_at
          FROM orders AS observed_order
          JOIN broker_events AS event ON event.event_id = observed_order.event_id
          JOIN intents AS intent ON intent.intent_id = observed_order.intent_id
          JOIN autonomous_cycles AS cycle ON cycle.cycle_id = intent.cycle_id
          CROSS JOIN latest_reconciliation
          WHERE observed_order.account_id = ${accountId}
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'order')}
            AND cycle.account_id = ${accountId}
            AND cycle.state = 'COMPLETED'
            AND cycle.terminal_at <= latest_reconciliation.reconciled_at
            AND event.observed_at <= latest_reconciliation.reconciled_at
          ORDER BY
            observed_order.intent_id,
            event.source_sequence DESC,
            event.event_id COLLATE "C" DESC
        `.pipe(Effect.flatMap(decodeExecutionOrders))
        const executionFillRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT
            event.event_id,
            fill.fill_id,
            fill.broker_order_id,
            fill.client_order_id,
            fill.intent_id,
            fill.account_id,
            fill.symbol,
            fill.side,
            fill.quantity_micros::text AS quantity_micros,
            fill.price_micros::text AS price_micros,
            fill.fee_micros::text AS fee_micros,
            fill.source_timestamp,
            event.occurred_at,
            event.observed_at
          FROM fills AS fill
          JOIN broker_events AS event ON event.event_id = fill.event_id
          JOIN intents AS intent ON intent.intent_id = fill.intent_id
          JOIN autonomous_cycles AS cycle ON cycle.cycle_id = intent.cycle_id
          CROSS JOIN latest_reconciliation
          WHERE fill.account_id = ${accountId}
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'fill')}
            AND cycle.account_id = ${accountId}
            AND cycle.state = 'COMPLETED'
            AND cycle.terminal_at <= latest_reconciliation.reconciled_at
            AND event.observed_at <= latest_reconciliation.reconciled_at
          ORDER BY
            intent.cycle_id COLLATE "C",
            fill.intent_id COLLATE "C",
            fill.source_timestamp COLLATE "C",
            fill.fill_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeExecutionFills))
        const durableExecutionRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          ), first_cycle AS (
            SELECT cycle.submission_open_at
            FROM autonomous_cycles AS cycle
            WHERE cycle.account_id = ${accountId}
              AND cycle.state IN ('COMPLETED', 'NO_TRADE')
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
            ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
            LIMIT 1
          ), opening_snapshot AS (
            SELECT event.observed_at
            FROM account_snapshots AS snapshot
            JOIN broker_events AS event ON event.event_id = snapshot.event_id
            CROSS JOIN latest_reconciliation
            CROSS JOIN first_cycle
            WHERE snapshot.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'opening-snapshot')}
              AND event.observed_at <= ${openingSnapshotBoundary(sql, accountId, authorityGenerationHash)}
              AND event.observed_at <= latest_reconciliation.reconciled_at
            ORDER BY event.observed_at DESC, event.source_sequence DESC, event.event_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT DISTINCT
            generation.account_id,
            generation.broker_identity_hash,
            generation.broker_provider,
            generation.broker_environment,
            generation.qualification_run_id,
            generation.strategy_name,
            generation.protocol_hash,
            generation.strategy_behavior_hash,
            generation.strategy_parameter_hash,
            generation.strategy_parameter_schema_version,
            generation.qualification_execution_policy_hash,
            generation.qualification_source_revision,
            generation.qualification_image_repository,
            generation.qualification_image_digest
          FROM accounting_transactions AS transaction
          CROSS JOIN latest_reconciliation
          CROSS JOIN opening_snapshot
          JOIN intents AS intent ON intent.intent_id = transaction.intent_id
          JOIN authority_generations AS generation
            ON generation.generation_hash = intent.authority_generation_hash
          WHERE transaction.account_id = ${accountId}
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'transaction')}
            AND transaction.occurred_at >= opening_snapshot.observed_at
            AND transaction.occurred_at <= latest_reconciliation.reconciled_at
          ORDER BY
            generation.account_id,
            generation.broker_identity_hash,
            generation.broker_provider,
            generation.broker_environment,
            generation.qualification_run_id,
            generation.strategy_name,
            generation.protocol_hash,
            generation.strategy_behavior_hash,
            generation.strategy_parameter_hash,
            generation.strategy_parameter_schema_version,
            generation.qualification_execution_policy_hash,
            generation.qualification_source_revision,
            generation.qualification_image_repository,
            generation.qualification_image_digest
        `.pipe(Effect.flatMap(decodeDurableExecutions))

        const [unclosedCycles] = yield* sql<Record<string, unknown>>`
          SELECT count(*)::integer AS count
          FROM autonomous_cycles AS cycle
          WHERE cycle.account_id = ${accountId}
            -- A terminally blocked PAPER cycle is terminal evidence of an incomplete generation.
            -- Count it as unclosed so an earlier successful cycle cannot produce a sufficient receipt.
            AND cycle.state IN ('PENDING', 'ACTIVE', 'BLOCKED')
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
        `.pipe(Effect.flatMap(decodeCount))

        const [unresolvedMutations] = yield* sql<Record<string, unknown>>`
          SELECT count(*)::integer AS count
          FROM intents AS intent
          LEFT JOIN LATERAL (
            SELECT event_type
            FROM mutation_events
            WHERE intent_id = intent.intent_id
            ORDER BY
              CASE operation WHEN 'CANCEL' THEN 1 ELSE 0 END DESC,
              sequence DESC
            LIMIT 1
          ) AS latest_mutation ON true
          WHERE intent.account_id = ${accountId}
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'intent')}
            AND (
              intent.state <> 'TERMINAL'
              OR latest_mutation.event_type IN (
                'SUBMIT_STARTED', 'SUBMIT_UNKNOWN', 'RECOVERY_UNKNOWN',
                'CANCEL_STARTED', 'CANCEL_UNKNOWN'
              )
            )
        `.pipe(Effect.flatMap(decodeCount))

        const [postReconciliationActivity] = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT count(*)::integer AS count
          FROM (
            SELECT transaction.transaction_id AS activity_id
            FROM accounting_transactions AS transaction
            CROSS JOIN latest_reconciliation
            WHERE transaction.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'transaction')}
              AND transaction.occurred_at > latest_reconciliation.reconciled_at
            UNION ALL
            SELECT fill.event_id AS activity_id
            FROM fills AS fill
            JOIN broker_events AS event ON event.event_id = fill.event_id
            CROSS JOIN latest_reconciliation
            WHERE fill.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'fill')}
              AND event.occurred_at > latest_reconciliation.reconciled_at
              AND NOT EXISTS (
                SELECT 1
                FROM accounting_transactions AS transaction
                WHERE transaction.broker_event_id = fill.event_id
              )
            UNION ALL
            SELECT event.event_id AS activity_id
            FROM mutation_events AS event
            JOIN intents AS intent ON intent.intent_id = event.intent_id
            CROSS JOIN latest_reconciliation
            WHERE intent.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'mutation')}
              AND event.occurred_at >= latest_reconciliation.reconciled_at
          ) AS activity
        `.pipe(Effect.flatMap(decodeCount))

        const [openPositions] = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT count(*)::integer AS count
          FROM (
            SELECT transaction.symbol
            FROM accounting_transactions AS transaction
            CROSS JOIN latest_reconciliation
            WHERE transaction.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'transaction')}
              AND transaction.occurred_at <= latest_reconciliation.reconciled_at
            GROUP BY transaction.symbol
            HAVING sum(transaction.quantity_delta_micros) <> 0
              OR sum(transaction.cost_basis_delta_micros) <> 0
          ) AS open_position
        `.pipe(Effect.flatMap(decodeCount))

        const [unaccountedFills] = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciliation.reconciled_at
            FROM reconciliations AS reconciliation
            WHERE reconciliation.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'reconciliation')}
            ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT count(*)::integer AS count
          FROM fills AS fill
          JOIN broker_events AS event ON event.event_id = fill.event_id
          CROSS JOIN latest_reconciliation
          LEFT JOIN accounting_transactions AS transaction ON transaction.broker_event_id = fill.event_id
            LEFT JOIN accounting_receipts AS receipt ON receipt.broker_event_id = fill.event_id
            WHERE fill.account_id = ${accountId}
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'fill')}
              AND event.occurred_at <= latest_reconciliation.reconciled_at
            AND (transaction.transaction_id IS NULL OR receipt.receipt_id IS NULL)
        `.pipe(Effect.flatMap(decodeCount))

        const cycles = cycleRows.map(
          (row): ForwardPerformanceCycleEvidence => ({
            cycleId: row.cycle_id,
            qualificationRunId: row.qualification_run_id,
            strategyName: row.strategy_name,
            strategyProtocolHash: row.strategy_protocol_hash,
            accountId: row.account_id,
            executionPolicyHash: row.execution_policy_hash,
            strategyExecutionModelHash: row.strategy_execution_model_hash,
            state: row.state,
            submissionOpenAt: row.submission_open_at.toISOString(),
            terminalAt: row.terminal_at.toISOString(),
          }),
        )
        const strategyRow = strategyRows[0]
        const strategy: ForwardPerformanceStrategyEvidence | undefined =
          strategyRow === undefined
            ? undefined
            : {
                qualificationRunId: strategyRow.qualification_run_id,
                strategyName: strategyRow.strategy_name,
                strategyProtocolHash: strategyRow.strategy_protocol_hash,
                strategyBehaviorHash: strategyRow.strategy_behavior_hash,
                strategyParameterHash: strategyRow.strategy_parameter_hash,
                strategyParameterSchemaVersion: strategyRow.strategy_parameter_schema_version,
                sourceRevision: strategyRow.source_revision,
                imageRepository: strategyRow.image_repository,
                imageDigest: strategyRow.image_digest,
              }
        const reconciliationRow = reconciliationRows[0]
        const cashYieldRow = cashYieldRows[0]
        const exactness =
          reconciliationRow === undefined
            ? { performanceExact: false, cashYieldAdjustedExact: false }
            : reconciliationExactness(accountId, reconciliationRow, cashYieldRow)
        const reconciliation =
          reconciliationRow === undefined
            ? undefined
            : {
                reconciliationId: reconciliationRow.reconciliation_id,
                contentHash: reconciliationRow.content_hash,
                status: reconciliationRow.status,
                ...exactness,
                reconciledAt: reconciliationRow.reconciled_at.toISOString(),
              }
        const cashYieldEvidence: ForwardPerformanceCashYieldEvidence | undefined =
          cashYieldRow === undefined
            ? undefined
            : {
                schemaVersion: 'bayn.forward-performance-cash-yield-evidence.v1',
                reconciliationId: cashYieldRow.reconciliation_id,
                reconciliationContentHash: cashYieldRow.reconciliation_content_hash,
                reconciledAt: cashYieldRow.reconciled_at.toISOString(),
                baselineAccountEventId: cashYieldRow.baseline_account_event_id,
                baselineObservedAt: cashYieldRow.baseline_observed_at.toISOString(),
                baselineCashMicros: cashYieldRow.baseline_cash_micros,
                openingAccountEventId: cashYieldRow.opening_account_event_id,
                openingObservedAt: cashYieldRow.opening_observed_at.toISOString(),
                openingCashMicros: cashYieldRow.opening_cash_micros,
                preWindowAccountedCashDeltaMicros: cashYieldRow.pre_window_accounted_cash_delta_micros,
                preWindowCashResidualMicros: cashYieldRow.pre_window_cash_residual_micros,
                closingAccountEventId: cashYieldRow.closing_account_event_id,
                closingObservedAt: cashYieldRow.closing_observed_at.toISOString(),
                closingCashMicros: cashYieldRow.closing_cash_micros,
                accountedCashDeltaMicros: cashYieldRow.accounted_cash_delta_micros,
                cashYieldMicros: cashYieldRow.cash_yield_micros,
              }
        const transactions = transactionRows.map(accountingTransactionFromRow)
        const transactionEvidence = transactionRows.map(
          (row): ForwardPerformanceTransactionEvidence => ({
            transactionId: row.transaction_id,
            brokerEventId: row.broker_event_id,
            ...(row.intent_id === null ? {} : { intentId: row.intent_id }),
            cycleId: row.cycle_id ?? '',
            symbol: row.symbol,
            side: row.side,
            quantityMicros: row.quantity_micros,
            priceMicros: row.price_micros,
            notionalMicros: row.notional_micros,
            feeMicros: row.fee_micros,
            realizedPnlMicros: row.realized_pnl_micros,
            occurredAt: row.occurred_at.toISOString(),
          }),
        )
        const executionEvidence = executionEvidenceFromRows(
          cycleDecisionRows,
          executionIntentRows,
          executionOrderRows,
          executionFillRows,
        )
        const marketVolumeRequests = marketVolumeRequestsFromRows(
          executionEvidence,
          marketVolumeBindingRows,
          reconciliation?.reconciledAt,
        )

        return {
          cycles,
          ...(strategy === undefined ? {} : { strategy }),
          ...(reconciliation === undefined ? {} : { reconciliation }),
          ...(startingCapitalRows[0] === undefined
            ? {}
            : { startingCapitalMicros: startingCapitalRows[0].starting_capital_micros }),
          ...(cashYieldEvidence === undefined ? {} : { cashYieldEvidence }),
          transactions,
          transactionEvidence,
          executionEvidence,
          marketVolumeRequests,
          receipts,
          durableExecutionBindings: durableExecutionRows.map((row) => ({
            accountId: row.account_id ?? '',
            accountReferenceHash: row.broker_identity_hash ?? '',
            provider: row.broker_provider ?? '',
            environment: row.broker_environment ?? '',
            qualificationRunId: row.qualification_run_id ?? '',
            strategyName: row.strategy_name ?? '',
            strategyProtocolHash: row.protocol_hash ?? '',
            strategyBehaviorHash: row.strategy_behavior_hash ?? '',
            strategyParameterHash: row.strategy_parameter_hash ?? '',
            strategyParameterSchemaVersion: row.strategy_parameter_schema_version ?? '',
            executionPolicyHash: row.qualification_execution_policy_hash ?? '',
            sourceRevision: row.qualification_source_revision ?? '',
            imageRepository: row.qualification_image_repository ?? '',
            imageDigest: row.qualification_image_digest ?? '',
          })),
          unclosedCycleCount: unclosedCycles.count,
          unresolvedMutationCount: unresolvedMutations.count,
          openPositionCount: openPositions.count,
          unaccountedFillCount: unaccountedFills.count,
          postReconciliationActivityCount: postReconciliationActivity.count,
        }
      }),
    )
    .pipe(Effect.mapError(postgresError))
