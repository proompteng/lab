import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, pipe, Result, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import {
  type CycleEconomicsObservation,
  type CycleExecutionFunnelObservation,
  type CycleOperationsProjection,
  type CycleOperationsSnapshot,
  type DurableAuthorityObservation,
  type ReconciliationObservation,
} from '../observability'
import { CycleState, CycleTerminalReason } from '../model'
import { Authority, KillState, ReconciliationStatus } from '../../execution/contracts'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'

export class CycleObservabilityError extends Data.TaggedError('CycleObservabilityError')<{
  readonly operation: 'read'
  readonly failure: 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CycleObservabilityShape {
  readonly read: (
    qualificationRunId: string,
    accountId?: string,
  ) => Effect.Effect<CycleOperationsProjection, CycleObservabilityError>
}

export class CycleObservability extends Context.Service<CycleObservability, CycleObservabilityShape>()(
  '@proompteng/bayn/cycle/store/CycleObservability',
) {}

const NullableDate = Schema.NullOr(Schema.Date)
const NullableString = Schema.NullOr(Schema.String)
const NullableSha256 = Schema.NullOr(Sha256Schema)
const NullableInstant = Schema.NullOr(Schema.Date)
const NullableCycleState = Schema.NullOr(Schema.Enum(CycleState))
const NullableTerminalReason = Schema.NullOr(Schema.Enum(CycleTerminalReason))
const NullableSignedMicros = Schema.NullOr(SignedMicrosSchema)
const NullableForwardPerformanceEvidenceStatus = Schema.NullOr(Schema.Literals(['SUFFICIENT', 'INSUFFICIENT_EVIDENCE']))
const NullableForwardPerformanceProfitability = Schema.NullOr(
  Schema.Literals(['PROFITABLE', 'NOT_PROFITABLE', 'UNDETERMINED']),
)
const NullableReturnDecimal = Schema.NullOr(Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9][0-9]*)\.[0-9]+$/)))

const CycleDecisionObservationRowSchema = Schema.Struct({
  createdAt: UtcInstantSchema,
  marketDataObservedAt: Schema.NullOr(UtcInstantSchema),
  barCount: NonNegativeIntegerSchema,
  quoteCount: NonNegativeIntegerSchema,
  tradeCount: NonNegativeIntegerSchema,
  targetPlanStatus: Schema.Literals(['PLANNED', 'NO_TRADE', 'BLOCKED']),
  targetPlanReason: NullableString,
  targetCount: NonNegativeIntegerSchema,
  orderedIntentCount: NonNegativeIntegerSchema,
  dispatchable: Schema.Boolean,
  riskBlockReason: NullableString,
  riskBlockReasonCount: NonNegativeIntegerSchema,
})

const CycleExecutionFunnelObservationRowSchema = Schema.Struct({
  decision: Schema.NullOr(CycleDecisionObservationRowSchema),
  intentCount: NonNegativeIntegerSchema,
  plannedIntentCount: NonNegativeIntegerSchema,
  approvedIntentCount: NonNegativeIntegerSchema,
  ioStartedIntentCount: NonNegativeIntegerSchema,
  acknowledgedIntentCount: NonNegativeIntegerSchema,
  unknownIntentCount: NonNegativeIntegerSchema,
  terminalIntentCount: NonNegativeIntegerSchema,
  recoveredIntentCount: NonNegativeIntegerSchema,
  filledIntentCount: NonNegativeIntegerSchema,
  canceledIntentCount: NonNegativeIntegerSchema,
  expiredIntentCount: NonNegativeIntegerSchema,
  rejectedIntentCount: NonNegativeIntegerSchema,
  blockedIntentCount: NonNegativeIntegerSchema,
  orderCount: NonNegativeIntegerSchema,
  openOrderCount: NonNegativeIntegerSchema,
  filledOrderCount: NonNegativeIntegerSchema,
  executedOrderCount: NonNegativeIntegerSchema,
  canceledOrderCount: NonNegativeIntegerSchema,
  expiredOrderCount: NonNegativeIntegerSchema,
  rejectedOrderCount: NonNegativeIntegerSchema,
  fillCount: NonNegativeIntegerSchema,
  buyFillCount: NonNegativeIntegerSchema,
  sellFillCount: NonNegativeIntegerSchema,
  latestIntentAt: Schema.NullOr(UtcInstantSchema),
  latestOrderAt: Schema.NullOr(UtcInstantSchema),
  latestFillAt: Schema.NullOr(UtcInstantSchema),
  maximumOrderAcknowledgementLatencyMs: Schema.NullOr(NonNegativeIntegerSchema),
  maximumFillLatencyMs: Schema.NullOr(NonNegativeIntegerSchema),
  positionSnapshotObservedAt: Schema.NullOr(UtcInstantSchema),
  positionCount: Schema.NullOr(NonNegativeIntegerSchema),
  grossExposureMicros: NullableSignedMicros,
  netExposureMicros: NullableSignedMicros,
  unrealizedPnlMicros: NullableSignedMicros,
  accountObservedAt: Schema.NullOr(UtcInstantSchema),
  cashMicros: NullableSignedMicros,
  equityMicros: NullableSignedMicros,
  buyingPowerMicros: NullableSignedMicros,
})

const ProjectionRowSchema = Schema.Struct({
  current_cycle_id: NullableSha256,
  current_account_id: Schema.NullOr(StrictNonEmptyStringSchema),
  current_signal_session_date: Schema.NullOr(IsoDateSchema),
  current_execution_session_date: Schema.NullOr(IsoDateSchema),
  current_state: NullableCycleState,
  current_snapshot_id: NullableSha256,
  current_decision_hash: NullableSha256,
  current_terminal_reason: NullableTerminalReason,
  current_submission_open_at: NullableDate,
  current_submission_cutoff_at: NullableDate,
  current_execution_open_at: NullableDate,
  current_execution_close_at: NullableDate,
  current_created_at: NullableDate,
  current_updated_at: NullableDate,
  current_terminal_at: NullableInstant,
  last_cycle_id: NullableSha256,
  last_account_id: Schema.NullOr(StrictNonEmptyStringSchema),
  last_signal_session_date: Schema.NullOr(IsoDateSchema),
  last_execution_session_date: Schema.NullOr(IsoDateSchema),
  last_state: NullableCycleState,
  last_snapshot_id: NullableSha256,
  last_decision_hash: NullableSha256,
  last_terminal_reason: NullableTerminalReason,
  last_submission_open_at: NullableDate,
  last_submission_cutoff_at: NullableDate,
  last_execution_open_at: NullableDate,
  last_execution_close_at: NullableDate,
  last_created_at: NullableDate,
  last_updated_at: NullableDate,
  last_terminal_at: NullableInstant,
  selected_account_id: Schema.NullOr(StrictNonEmptyStringSchema),
  account_mismatch: Schema.Boolean,
  unfinished_cycle_count: NonNegativeIntegerSchema,
  authority_generation_hash: NullableSha256,
  authority_maximum: Schema.NullOr(Schema.Enum(Authority)),
  authority_effective: Schema.NullOr(Schema.Enum(Authority)),
  authority_kill: Schema.NullOr(Schema.Enum(KillState)),
  authority_reason: NullableString,
  authority_updated_at: NullableDate,
  reconciliation_id: NullableSha256,
  reconciliation_account_id: Schema.NullOr(StrictNonEmptyStringSchema),
  reconciliation_status: Schema.NullOr(Schema.Enum(ReconciliationStatus)),
  reconciliation_discrepancy_count: Schema.NullOr(NonNegativeIntegerSchema),
  reconciled_at: NullableDate,
  reconciliation_covers_latest_mutation: Schema.NullOr(Schema.Boolean),
  mutation_event_count: NonNegativeIntegerSchema,
  mutation_recovery_found_count: NonNegativeIntegerSchema,
  approved_intent_count: NonNegativeIntegerSchema,
  acknowledged_intent_count: NonNegativeIntegerSchema,
  unresolved_mutation_count: NonNegativeIntegerSchema,
  oldest_unresolved_mutation_at: NullableDate,
  latest_mutation_at: NullableDate,
  execution_funnel: CycleExecutionFunnelObservationRowSchema,
  accounting_fill_count: NonNegativeIntegerSchema,
  accounting_transaction_count: NonNegativeIntegerSchema,
  accounting_receipt_count: NonNegativeIntegerSchema,
  accounting_realized_close_count: NonNegativeIntegerSchema,
  unaccounted_fill_count: NonNegativeIntegerSchema,
  unreceipted_transaction_count: NonNegativeIntegerSchema,
  accounting_gross_realized_pnl_micros: SignedMicrosSchema,
  accounting_execution_fees_micros: SignedMicrosSchema,
  accounting_net_realized_pnl_after_execution_fees_micros: SignedMicrosSchema,
  performance_receipt_created_at: NullableDate,
  performance_evidence_status: NullableForwardPerformanceEvidenceStatus,
  performance_profitability: NullableForwardPerformanceProfitability,
  performance_gross_realized_pnl_micros: NullableSignedMicros,
  performance_broker_execution_fees_micros: NullableSignedMicros,
  performance_other_charged_costs_micros: NullableSignedMicros,
  performance_net_realized_pnl_after_costs_micros: NullableSignedMicros,
  performance_net_realized_return_decimal: NullableReturnDecimal,
  performance_completed_execution_count: Schema.NullOr(NonNegativeIntegerSchema),
  performance_realized_close_count: Schema.NullOr(NonNegativeIntegerSchema),
  performance_accounting_receipts_exact: Schema.NullOr(Schema.Boolean),
  performance_ledger_exact: Schema.NullOr(Schema.Boolean),
})
type ProjectionRow = typeof ProjectionRowSchema.Type
export type CycleObservabilityProjectionRow = ProjectionRow

const ProjectionRowsSchema = Schema.Tuple([ProjectionRowSchema])
const decodeRunId = Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)
const decodeAccountId = Schema.decodeUnknownEffect(StrictNonEmptyStringSchema, strictParseOptions)
const decodeProjectionRowsResult = Schema.decodeUnknownResult(ProjectionRowsSchema, strictParseOptions)

export const decodeCycleObservabilityProjectionRows = (
  rows: unknown,
): Result.Result<readonly [CycleObservabilityProjectionRow], Schema.SchemaError> => decodeProjectionRowsResult(rows)

const messageOf = (cause: unknown): string =>
  pipe(
    Result.try(() => (cause instanceof Error ? cause.message : String(cause))),
    Result.getOrElse(() => '<unrenderable cause>'),
  )

const readError = (
  failure: CycleObservabilityError['failure'],
  message: string,
  cause?: unknown,
): CycleObservabilityError =>
  new CycleObservabilityError({
    operation: 'read',
    failure,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

const snapshotFromRow = (
  row: ProjectionRow,
  prefix: 'current' | 'last',
): Result.Result<CycleOperationsSnapshot | null, CycleObservabilityError> => {
  const cycleId = row[`${prefix}_cycle_id`]
  if (cycleId === null) return Result.succeed(null)
  const accountId = row[`${prefix}_account_id`]
  const signalSessionDate = row[`${prefix}_signal_session_date`]
  const executionSessionDate = row[`${prefix}_execution_session_date`]
  const authoritySessionDate = signalSessionDate ?? executionSessionDate
  const phase = row[`${prefix}_state`]
  const submissionOpenAt = row[`${prefix}_submission_open_at`]
  const submissionCutoffAt = row[`${prefix}_submission_cutoff_at`]
  const executionOpenAt = row[`${prefix}_execution_open_at`]
  const executionCloseAt = row[`${prefix}_execution_close_at`]
  const createdAt = row[`${prefix}_created_at`]
  const updatedAt = row[`${prefix}_updated_at`]
  if (
    accountId === null ||
    authoritySessionDate === null ||
    executionSessionDate === null ||
    phase === null ||
    submissionOpenAt === null ||
    submissionCutoffAt === null ||
    executionOpenAt === null ||
    executionCloseAt === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return Result.fail(readError('invariant', `${prefix} cycle projection is incomplete`))
  }
  return Result.succeed({
    cycleId,
    accountId,
    signalSessionDate: authoritySessionDate,
    executionSessionDate,
    phase,
    snapshotId: row[`${prefix}_snapshot_id`],
    decisionHash: row[`${prefix}_decision_hash`],
    terminalReason: row[`${prefix}_terminal_reason`],
    submissionOpenAt: submissionOpenAt.toISOString(),
    submissionCutoffAt: submissionCutoffAt.toISOString(),
    executionOpenAt: executionOpenAt.toISOString(),
    executionCloseAt: executionCloseAt.toISOString(),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    terminalAt: row[`${prefix}_terminal_at`]?.toISOString() ?? null,
  })
}

const authorityFromRow = (
  row: ProjectionRow,
): Result.Result<DurableAuthorityObservation | null, CycleObservabilityError> => {
  if (row.authority_maximum === null) return Result.succeed(null)
  if (
    row.authority_generation_hash === null ||
    row.authority_effective === null ||
    row.authority_kill === null ||
    row.authority_updated_at === null
  ) {
    return Result.fail(readError('invariant', 'durable authority projection is incomplete'))
  }
  return Result.succeed({
    generationHash: row.authority_generation_hash,
    maximum: row.authority_maximum,
    effective: row.authority_effective,
    kill: row.authority_kill,
    reason: row.authority_reason,
    updatedAt: row.authority_updated_at.toISOString(),
  })
}

const reconciliationFromRow = (
  row: ProjectionRow,
): Result.Result<ReconciliationObservation | null, CycleObservabilityError> => {
  if (row.reconciliation_id === null) return Result.succeed(null)
  if (
    row.reconciliation_account_id === null ||
    row.reconciliation_status === null ||
    row.reconciliation_discrepancy_count === null ||
    row.reconciled_at === null ||
    row.reconciliation_covers_latest_mutation === null
  ) {
    return Result.fail(readError('invariant', 'reconciliation projection is incomplete'))
  }
  return Result.succeed({
    reconciliationId: row.reconciliation_id,
    accountId: row.reconciliation_account_id,
    status: row.reconciliation_status,
    discrepancyCount: row.reconciliation_discrepancy_count,
    reconciledAt: row.reconciled_at.toISOString(),
    coversLatestMutation: row.reconciliation_covers_latest_mutation,
  })
}

const economicsFromRow = (row: ProjectionRow): Result.Result<CycleEconomicsObservation, CycleObservabilityError> => {
  const receiptCreatedAt = row.performance_receipt_created_at
  const evidenceStatus = row.performance_evidence_status
  const profitability = row.performance_profitability
  const completedExecutionCount = row.performance_completed_execution_count
  const realizedCloseCount = row.performance_realized_close_count
  const accountingReceiptsExact = row.performance_accounting_receipts_exact
  const ledgerExact = row.performance_ledger_exact
  const receiptRequiredFields = [
    evidenceStatus,
    profitability,
    completedExecutionCount,
    realizedCloseCount,
    accountingReceiptsExact,
    ledgerExact,
  ] as const
  const hasReceiptFields = receiptRequiredFields.some((field) => field !== null)
  if (receiptCreatedAt === null && hasReceiptFields) {
    return Result.fail(readError('invariant', 'forward-performance economics projection is incomplete'))
  }

  let forwardPerformance: CycleEconomicsObservation['forwardPerformance'] = null
  if (receiptCreatedAt !== null) {
    if (
      evidenceStatus === null ||
      profitability === null ||
      completedExecutionCount === null ||
      realizedCloseCount === null ||
      accountingReceiptsExact === null ||
      ledgerExact === null
    ) {
      return Result.fail(readError('invariant', 'forward-performance economics projection is incomplete'))
    }
    forwardPerformance = {
      createdAt: receiptCreatedAt.toISOString(),
      evidenceStatus,
      profitability,
      grossRealizedPnlMicros: row.performance_gross_realized_pnl_micros,
      brokerExecutionFeesMicros: row.performance_broker_execution_fees_micros,
      otherChargedCostsMicros: row.performance_other_charged_costs_micros,
      netRealizedPnlAfterCostsMicros: row.performance_net_realized_pnl_after_costs_micros,
      netRealizedReturnDecimal: row.performance_net_realized_return_decimal,
      completedExecutionCount,
      realizedCloseCount,
      accountingReceiptsExact,
      ledgerExact,
    }
  }

  return Result.succeed({
    accounting: {
      fillCount: row.accounting_fill_count,
      transactionCount: row.accounting_transaction_count,
      receiptCount: row.accounting_receipt_count,
      realizedCloseCount: row.accounting_realized_close_count,
      unaccountedFillCount: row.unaccounted_fill_count,
      unreceiptedTransactionCount: row.unreceipted_transaction_count,
      grossRealizedPnlMicros: row.accounting_gross_realized_pnl_micros,
      executionFeesMicros: row.accounting_execution_fees_micros,
      netRealizedPnlAfterExecutionFeesMicros: row.accounting_net_realized_pnl_after_execution_fees_micros,
    },
    forwardPerformance,
  })
}

const executionFromRow = (row: ProjectionRow): CycleExecutionFunnelObservation => row.execution_funnel

export const projectCycleObservabilityRow = (
  row: CycleObservabilityProjectionRow,
): Result.Result<CycleOperationsProjection, CycleObservabilityError> => {
  if (row.account_mismatch) {
    return Result.fail(
      readError(
        'invariant',
        `configured account ${row.selected_account_id ?? 'unknown'} differs from the projected current or last cycle`,
      ),
    )
  }
  return pipe(
    Result.all({
      current: snapshotFromRow(row, 'current'),
      last: snapshotFromRow(row, 'last'),
      authority: authorityFromRow(row),
      reconciliation: reconciliationFromRow(row),
      economics: economicsFromRow(row),
    }),
    Result.map(({ current, last, authority, reconciliation, economics }) => ({
      current,
      last,
      unfinishedCycleCount: row.unfinished_cycle_count,
      authority,
      reconciliation,
      mutations: {
        eventCount: row.mutation_event_count,
        recoveryFoundCount: row.mutation_recovery_found_count,
        approvedIntentCount: row.approved_intent_count,
        acknowledgedIntentCount: row.acknowledged_intent_count,
        unresolvedCount: row.unresolved_mutation_count,
        oldestUnresolvedAt: row.oldest_unresolved_mutation_at?.toISOString() ?? null,
        latestOccurredAt: row.latest_mutation_at?.toISOString() ?? null,
      },
      execution: executionFromRow(row),
      economics,
    })),
  )
}

const makeCycleObservability = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient

  const read = (
    qualificationRunId: string,
    accountId?: string,
  ): Effect.Effect<CycleOperationsProjection, CycleObservabilityError> =>
    Effect.all([
      decodeRunId(qualificationRunId).pipe(
        Effect.mapError((cause) => readError('decode', 'invalid qualification run identity', cause)),
      ),
      accountId === undefined
        ? Effect.void
        : decodeAccountId(accountId).pipe(
            Effect.mapError((cause) => readError('decode', 'invalid cycle observability account identity', cause)),
          ),
    ]).pipe(
      Effect.flatMap(([runId, expectedAccountId]) =>
        sql<Record<string, unknown>>`
          WITH scoped_cycles AS (
            SELECT *
            FROM autonomous_cycles
            WHERE qualification_run_id = ${runId}
          ),
          current_cycle AS (
            SELECT *
            FROM scoped_cycles
            WHERE state IN ('PENDING', 'ACTIVE')
            ORDER BY execution_session_date DESC, created_at DESC, cycle_id
            LIMIT 1
          ),
          last_cycle AS (
            SELECT *
            FROM scoped_cycles
            WHERE state IN ('COMPLETED', 'NO_TRADE', 'BLOCKED')
            ORDER BY execution_session_date DESC, terminal_at DESC, cycle_id
            LIMIT 1
          ),
          observed_cycle AS (
            SELECT * FROM current_cycle
            UNION ALL
            SELECT * FROM last_cycle
            WHERE NOT EXISTS (SELECT 1 FROM current_cycle)
            LIMIT 1
          ),
          requested_account AS (
            SELECT ${expectedAccountId ?? null}::text AS account_id
          ),
          selected_account AS (
            SELECT coalesce(
              (SELECT account_id FROM requested_account),
              (SELECT account_id FROM current_cycle),
              (SELECT account_id FROM last_cycle)
            ) AS account_id
          ),
          observed_decision AS (
            SELECT decision.*
            FROM autonomous_cycle_shadow_decisions AS decision
            JOIN observed_cycle AS cycle ON cycle.cycle_id = decision.cycle_id
            LIMIT 1
          ),
          cycle_intents AS (
            SELECT intent.*
            FROM intents AS intent
            JOIN observed_cycle AS cycle ON cycle.cycle_id = intent.cycle_id
            WHERE intent.account_id = (SELECT account_id FROM selected_account)
          ),
          cycle_order_events AS (
            SELECT
              orders.*,
              events.observed_at,
              events.source_sequence,
              intents.created_at AS intent_created_at
            FROM orders
            JOIN broker_events AS events ON events.event_id = orders.event_id
            JOIN cycle_intents AS intents
              ON intents.intent_id = orders.intent_id
              AND intents.account_id = orders.account_id
          ),
          latest_cycle_orders AS (
            SELECT DISTINCT ON (broker_order_id) *
            FROM cycle_order_events
            ORDER BY broker_order_id, source_sequence DESC, observed_at DESC, event_id DESC
          ),
          first_cycle_orders AS (
            SELECT DISTINCT ON (broker_order_id) *
            FROM cycle_order_events
            ORDER BY broker_order_id, source_sequence, observed_at, event_id
          ),
          cycle_fills AS (
            SELECT
              fills.*,
              events.observed_at,
              intents.created_at AS intent_created_at
            FROM fills
            JOIN broker_events AS events ON events.event_id = fills.event_id
            JOIN cycle_intents AS intents
              ON intents.intent_id = fills.intent_id
              AND intents.account_id = fills.account_id
          ),
          latest_account_snapshot AS (
            SELECT snapshot.*, events.observed_at
            FROM account_snapshots AS snapshot
            JOIN broker_events AS events ON events.event_id = snapshot.event_id
            WHERE snapshot.account_id = (SELECT account_id FROM selected_account)
            ORDER BY events.observed_at DESC, events.source_sequence DESC, snapshot.event_id DESC
            LIMIT 1
          ),
          latest_position_snapshot_time AS (
            SELECT max(snapshot.observed_at) AS observed_at
            FROM position_snapshots AS snapshot
            WHERE snapshot.account_id = (SELECT account_id FROM selected_account)
          ),
          latest_position_snapshot_candidates AS (
            SELECT snapshot.*
            FROM position_snapshots AS snapshot
            JOIN latest_position_snapshot_time AS latest ON latest.observed_at = snapshot.observed_at
            WHERE snapshot.account_id = (SELECT account_id FROM selected_account)
          ),
          latest_position_snapshot AS (
            SELECT snapshot.*
            FROM latest_position_snapshot_candidates AS snapshot
            WHERE snapshot.ingestion_order_trusted
              OR (SELECT count(*) FROM latest_position_snapshot_candidates) = 1
            ORDER BY snapshot.ingestion_order_trusted DESC, snapshot.ingestion_sequence DESC
            LIMIT 1
          ),
          current_positions AS (
            SELECT position.*
            FROM positions AS position
            JOIN latest_position_snapshot AS snapshot ON snapshot.snapshot_id = position.snapshot_id
          ),
          selected_fills AS (
            SELECT fill.*
            FROM fills AS fill
            WHERE fill.account_id = (SELECT account_id FROM selected_account)
          ),
          selected_accounting_transactions AS (
            SELECT transaction.*
            FROM accounting_transactions AS transaction
            WHERE transaction.account_id = (SELECT account_id FROM selected_account)
          ),
          selected_accounting_receipts AS (
            SELECT receipt.*
            FROM accounting_receipts AS receipt
            JOIN selected_accounting_transactions AS transaction
              ON transaction.broker_event_id = receipt.broker_event_id
          ),
          latest_performance_receipt AS (
            SELECT receipt.created_at, receipt.document -> 'receipt' AS document
            FROM autonomous_forward_performance_receipts AS receipt
            JOIN authority_generations AS generation
              ON generation.generation_hash = receipt.authority_generation_hash
            WHERE generation.account_id = (SELECT account_id FROM selected_account)
            ORDER BY receipt.created_at DESC, receipt.authority_generation_hash COLLATE "C" DESC
            LIMIT 1
          ),
          latest_reconciliation AS (
            SELECT *
            FROM reconciliations
            WHERE account_id = (SELECT account_id FROM selected_account)
            ORDER BY reconciled_at DESC, reconciliation_id DESC
            LIMIT 1
          ),
          account_intents AS (
            SELECT intent_id, state
            FROM intents
            WHERE account_id = (SELECT account_id FROM selected_account)
          ),
          account_mutation_events AS (
            SELECT
              events.*,
              intents.state
            FROM mutation_events AS events
            JOIN account_intents AS intents ON intents.intent_id = events.intent_id
          ),
          classified_mutation_events AS (
            SELECT
              events.*,
              (
                events.event_type IN (
                  'SUBMIT_STARTED',
                  'SUBMIT_UNKNOWN',
                  'RECOVERY_NOT_FOUND',
                  'RECOVERY_UNKNOWN',
                  'CANCEL_STARTED',
                  'CANCEL_ACCEPTED',
                  'CANCEL_UNKNOWN'
                )
                OR (
                  events.operation = 'CANCEL'
                  AND events.event_type = 'RECOVERY_FOUND'
                )
              ) AS is_unresolved
            FROM account_mutation_events AS events
          ),
          mutation_event_streaks AS (
            SELECT
              events.*,
              count(*) FILTER (WHERE NOT events.is_unresolved) OVER (
                PARTITION BY events.mutation_id
                ORDER BY events.sequence
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS resolved_epoch
            FROM classified_mutation_events AS events
          ),
          latest_mutations AS (
            SELECT DISTINCT ON (events.mutation_id)
              events.mutation_id,
              events.event_type,
              events.operation,
              events.state,
              events.is_unresolved,
              events.resolved_epoch
            FROM mutation_event_streaks AS events
            ORDER BY events.mutation_id, events.sequence DESC
          ),
          unresolved_mutations AS (
            SELECT
              latest.mutation_id,
              min(events.occurred_at) AS occurred_at
            FROM latest_mutations AS latest
            JOIN mutation_event_streaks AS events
              ON events.mutation_id = latest.mutation_id
              AND events.resolved_epoch = latest.resolved_epoch
              AND events.is_unresolved
            WHERE latest.state <> 'TERMINAL'
              AND latest.is_unresolved
            GROUP BY latest.mutation_id
          )
          SELECT
            current.cycle_id AS current_cycle_id,
            current.account_id AS current_account_id,
            current.signal_session_date::text AS current_signal_session_date,
            current.execution_session_date::text AS current_execution_session_date,
            current.state AS current_state,
            current.snapshot_id AS current_snapshot_id,
            current.decision_hash AS current_decision_hash,
            current.terminal_reason AS current_terminal_reason,
            current.submission_open_at AS current_submission_open_at,
            current.submission_cutoff_at AS current_submission_cutoff_at,
            current.execution_open_at AS current_execution_open_at,
            current.execution_close_at AS current_execution_close_at,
            current.created_at AS current_created_at,
            current.updated_at AS current_updated_at,
            current.terminal_at AS current_terminal_at,
            last.cycle_id AS last_cycle_id,
            last.account_id AS last_account_id,
            last.signal_session_date::text AS last_signal_session_date,
            last.execution_session_date::text AS last_execution_session_date,
            last.state AS last_state,
            last.snapshot_id AS last_snapshot_id,
            last.decision_hash AS last_decision_hash,
            last.terminal_reason AS last_terminal_reason,
            last.submission_open_at AS last_submission_open_at,
            last.submission_cutoff_at AS last_submission_cutoff_at,
            last.execution_open_at AS last_execution_open_at,
            last.execution_close_at AS last_execution_close_at,
            last.created_at AS last_created_at,
            last.updated_at AS last_updated_at,
            last.terminal_at AS last_terminal_at,
            (SELECT account_id FROM selected_account) AS selected_account_id,
            (
              (SELECT account_id FROM requested_account) IS NOT NULL
              AND (
                (
                  current.account_id IS NOT NULL
                  AND current.account_id <> (SELECT account_id FROM requested_account)
                )
                OR
                (
                  last.account_id IS NOT NULL
                  AND last.account_id <> (SELECT account_id FROM requested_account)
                )
              )
            ) AS account_mismatch,
            (
              SELECT count(*)::integer
              FROM scoped_cycles
              WHERE state IN ('PENDING', 'ACTIVE')
            ) AS unfinished_cycle_count,
            authority.generation_hash AS authority_generation_hash,
            authority.maximum AS authority_maximum,
            authority.effective AS authority_effective,
            authority.kill_state AS authority_kill,
            authority.reason AS authority_reason,
            authority.updated_at AS authority_updated_at,
            reconciliation.reconciliation_id,
            reconciliation.account_id AS reconciliation_account_id,
            reconciliation.status AS reconciliation_status,
            jsonb_array_length(reconciliation.discrepancies) AS reconciliation_discrepancy_count,
            reconciliation.reconciled_at,
            CASE
              WHEN reconciliation.reconciliation_id IS NULL THEN NULL
              WHEN NOT EXISTS (SELECT 1 FROM account_mutation_events) THEN true
              ELSE reconciliation.reconciled_at > (SELECT max(occurred_at) FROM account_mutation_events)
            END AS reconciliation_covers_latest_mutation,
            (SELECT count(*)::integer FROM account_mutation_events) AS mutation_event_count,
            (
              SELECT count(*)::integer
              FROM account_mutation_events
              WHERE event_type = 'RECOVERY_FOUND'
            ) AS mutation_recovery_found_count,
            (
              SELECT count(*)::integer
              FROM account_intents
              WHERE state = 'APPROVED'
            ) AS approved_intent_count,
            (
              SELECT count(*)::integer
              FROM account_intents
              WHERE state = 'ACKNOWLEDGED'
            ) AS acknowledged_intent_count,
            (SELECT count(*)::integer FROM unresolved_mutations) AS unresolved_mutation_count,
            (SELECT min(occurred_at) FROM unresolved_mutations) AS oldest_unresolved_mutation_at,
            (SELECT max(occurred_at) FROM account_mutation_events) AS latest_mutation_at,
            jsonb_build_object(
              'decision', CASE
                WHEN decision.cycle_id IS NULL THEN NULL
                ELSE jsonb_build_object(
                  'createdAt', to_char(decision.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  'marketDataObservedAt', CASE
                    WHEN decision.document #>> '{bindings,executionMarketData,observedAt}' IS NULL THEN NULL
                    ELSE decision.document #>> '{bindings,executionMarketData,observedAt}'
                  END,
                  'barCount', coalesce((decision.document #>> '{bindings,executionMarketData,barCount}')::integer, 0),
                  'quoteCount', coalesce((decision.document #>> '{bindings,executionMarketData,quoteCount}')::integer, 0),
                  'tradeCount', coalesce((decision.document #>> '{bindings,executionMarketData,tradeCount}')::integer, 0),
                  'targetPlanStatus', decision.document #>> '{targetPlan,status}',
                  'targetPlanReason', decision.document #>> '{targetPlan,reason}',
                  'targetCount', (
                    SELECT count(*)::integer
                    FROM jsonb_array_elements(coalesce(decision.document #> '{targetPlan,targets}', '[]'::jsonb)) AS target
                    WHERE (target ->> 'currentQuantityMicros')::numeric <>
                      (target ->> 'targetQuantityMicros')::numeric
                  ),
                  'orderedIntentCount', coalesce(jsonb_array_length(decision.document -> 'orderedIntentIds'), 0),
                  'dispatchable', coalesce((decision.document ->> 'dispatchable')::boolean, false),
                  'riskBlockReason', decision.document #>> '{riskBlock,reasonCodes,0}',
                  'riskBlockReasonCount', coalesce(jsonb_array_length(decision.document #> '{riskBlock,reasonCodes}'), 0)
                )
              END,
              'intentCount', (SELECT count(*)::integer FROM cycle_intents),
              'plannedIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE state = 'PLANNED'),
              'approvedIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE state = 'APPROVED'),
              'ioStartedIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE state = 'IO_STARTED'),
              'acknowledgedIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE state = 'ACKNOWLEDGED'),
              'unknownIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE state = 'UNKNOWN'),
              'terminalIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE state = 'TERMINAL'),
              'recoveredIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE state = 'RECOVERED'),
              'filledIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE terminal_outcome = 'FILLED'),
              'canceledIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE terminal_outcome = 'CANCELED'),
              'expiredIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE terminal_outcome = 'EXPIRED'),
              'rejectedIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE terminal_outcome = 'REJECTED'),
              'blockedIntentCount', (SELECT count(*)::integer FROM cycle_intents WHERE terminal_outcome = 'BLOCKED'),
              'orderCount', (SELECT count(*)::integer FROM latest_cycle_orders),
              'openOrderCount', (
                SELECT count(*)::integer FROM latest_cycle_orders
                WHERE status IN ('NEW', 'PARTIALLY_FILLED', 'PENDING')
              ),
              'filledOrderCount', (SELECT count(*)::integer FROM latest_cycle_orders WHERE status = 'FILLED'),
              'executedOrderCount', (SELECT count(DISTINCT broker_order_id)::integer FROM cycle_fills),
              'canceledOrderCount', (SELECT count(*)::integer FROM latest_cycle_orders WHERE status = 'CANCELED'),
              'expiredOrderCount', (SELECT count(*)::integer FROM latest_cycle_orders WHERE status = 'EXPIRED'),
              'rejectedOrderCount', (SELECT count(*)::integer FROM latest_cycle_orders WHERE status = 'REJECTED'),
              'fillCount', (SELECT count(*)::integer FROM cycle_fills),
              'buyFillCount', (SELECT count(*)::integer FROM cycle_fills WHERE side = 'BUY'),
              'sellFillCount', (SELECT count(*)::integer FROM cycle_fills WHERE side = 'SELL'),
              'latestIntentAt', (
                SELECT to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                FROM cycle_intents
              ),
              'latestOrderAt', (
                SELECT to_char(max(observed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                FROM latest_cycle_orders
              ),
              'latestFillAt', (
                SELECT to_char(max(observed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                FROM cycle_fills
              ),
              'maximumOrderAcknowledgementLatencyMs', (
                SELECT round(max(extract(epoch FROM (observed_at - intent_created_at))) * 1000)::bigint
                FROM first_cycle_orders
              ),
              'maximumFillLatencyMs', (
                SELECT round(max(extract(epoch FROM (observed_at - intent_created_at))) * 1000)::bigint
                FROM cycle_fills
              ),
              'positionSnapshotObservedAt', (
                SELECT to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                FROM latest_position_snapshot
              ),
              'positionCount', CASE
                WHEN EXISTS (SELECT 1 FROM latest_position_snapshot)
                THEN (SELECT count(*)::integer FROM current_positions WHERE quantity_micros <> 0)
                ELSE NULL
              END,
              'grossExposureMicros', CASE
                WHEN EXISTS (SELECT 1 FROM latest_position_snapshot)
                THEN coalesce((SELECT sum(abs(market_value_micros)) FROM current_positions), 0)::text
                ELSE NULL
              END,
              'netExposureMicros', CASE
                WHEN EXISTS (SELECT 1 FROM latest_position_snapshot)
                THEN coalesce((SELECT sum(market_value_micros) FROM current_positions), 0)::text
                ELSE NULL
              END,
              'unrealizedPnlMicros', CASE
                WHEN EXISTS (SELECT 1 FROM latest_position_snapshot)
                THEN coalesce((SELECT sum(unrealized_pnl_micros) FROM current_positions), 0)::text
                ELSE NULL
              END,
              'accountObservedAt', (
                SELECT to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                FROM latest_account_snapshot
              ),
              'cashMicros', (SELECT cash_micros::text FROM latest_account_snapshot),
              'equityMicros', (SELECT equity_micros::text FROM latest_account_snapshot),
              'buyingPowerMicros', (SELECT buying_power_micros::text FROM latest_account_snapshot)
            ) AS execution_funnel,
            (SELECT count(*)::integer FROM selected_fills) AS accounting_fill_count,
            (SELECT count(*)::integer FROM selected_accounting_transactions) AS accounting_transaction_count,
            (SELECT count(*)::integer FROM selected_accounting_receipts) AS accounting_receipt_count,
            (
              SELECT count(*)::integer
              FROM selected_accounting_transactions
              WHERE side = 'SELL'
            ) AS accounting_realized_close_count,
            (
              SELECT count(*)::integer
              FROM selected_fills AS fill
              LEFT JOIN selected_accounting_transactions AS transaction
                ON transaction.broker_event_id = fill.event_id
              WHERE transaction.transaction_id IS NULL
            ) AS unaccounted_fill_count,
            (
              SELECT count(*)::integer
              FROM selected_accounting_transactions AS transaction
              LEFT JOIN selected_accounting_receipts AS receipt
                ON receipt.broker_event_id = transaction.broker_event_id
              WHERE receipt.receipt_id IS NULL
            ) AS unreceipted_transaction_count,
            coalesce((SELECT sum(realized_pnl_micros) FROM selected_accounting_transactions), 0)::text
              AS accounting_gross_realized_pnl_micros,
            coalesce((SELECT sum(fee_micros) FROM selected_accounting_transactions), 0)::text
              AS accounting_execution_fees_micros,
            coalesce((SELECT sum(realized_pnl_micros - fee_micros) FROM selected_accounting_transactions), 0)::text
              AS accounting_net_realized_pnl_after_execution_fees_micros,
            (SELECT created_at FROM latest_performance_receipt) AS performance_receipt_created_at,
            (SELECT document -> 'evidence' ->> 'status' FROM latest_performance_receipt)
              AS performance_evidence_status,
            (SELECT document ->> 'profitability' FROM latest_performance_receipt)
              AS performance_profitability,
            (SELECT document -> 'totals' ->> 'grossRealizedPnlMicros' FROM latest_performance_receipt)
              AS performance_gross_realized_pnl_micros,
            (SELECT document -> 'totals' ->> 'brokerExecutionFeesMicros' FROM latest_performance_receipt)
              AS performance_broker_execution_fees_micros,
            (SELECT document -> 'totals' ->> 'otherChargedCostsMicros' FROM latest_performance_receipt)
              AS performance_other_charged_costs_micros,
            (SELECT document -> 'totals' ->> 'netRealizedPnlAfterCostsMicros' FROM latest_performance_receipt)
              AS performance_net_realized_pnl_after_costs_micros,
            (SELECT document -> 'totals' -> 'netRealizedReturn' ->> 'decimal' FROM latest_performance_receipt)
              AS performance_net_realized_return_decimal,
            (SELECT (document -> 'counts' ->> 'completedExecutionCount')::integer FROM latest_performance_receipt)
              AS performance_completed_execution_count,
            (SELECT (document -> 'counts' ->> 'realizedCloseCount')::integer FROM latest_performance_receipt)
              AS performance_realized_close_count,
            (SELECT (document -> 'reconciliationProof' ->> 'accountingReceiptsExact')::boolean FROM latest_performance_receipt)
              AS performance_accounting_receipts_exact,
            (SELECT (document -> 'reconciliationProof' ->> 'ledgerExact')::boolean FROM latest_performance_receipt)
              AS performance_ledger_exact
          FROM (VALUES (true)) AS singleton(seed)
          LEFT JOIN current_cycle AS current ON true
          LEFT JOIN last_cycle AS last ON true
          LEFT JOIN authority_state AS authority ON authority.singleton
          LEFT JOIN latest_reconciliation AS reconciliation ON true
          LEFT JOIN observed_decision AS decision ON true
        `.pipe(
          Effect.mapError((cause) =>
            isSqlError(cause)
              ? readError('query', 'autonomous cycle observability query failed', cause)
              : readError('query', 'autonomous cycle observability failed unexpectedly', cause),
          ),
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.fromResult(decodeCycleObservabilityProjectionRows(rows)).pipe(
          Effect.mapError((cause) => readError('decode', 'autonomous cycle observability decoding failed', cause)),
        ),
      ),
      Effect.flatMap(([row]) => Effect.fromResult(projectCycleObservabilityRow(row))),
    )

  return { read } satisfies CycleObservabilityShape
})

export const CycleObservabilityLive = Layer.effect(CycleObservability, makeCycleObservability)
