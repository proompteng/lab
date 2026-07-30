import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Schema } from 'effect'

import type { AccountingTransaction } from '../accounting/schema'
import { decodeAccountingReceipt, type AccountingReceipt } from '../execution/contracts'
import {
  AccountingReceiptRowSchema,
  AccountingTransactionRowSchema,
  accountingReceiptFromRow,
  accountingTransactionFromRow,
} from '../db/accounting-rows'
import {
  ImageDigestSchema,
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  strictParseOptions,
} from '../schemas'
import type {
  ForwardPerformanceCycleEvidence,
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
  reconciled_at: Schema.Date,
})

const StartingCapitalRow = Schema.Struct({ starting_capital_micros: Schema.String })
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
const decodeTransactions = Schema.decodeUnknownEffect(Schema.Array(TransactionRow), strictParseOptions)
const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(AccountingReceiptRowSchema), strictParseOptions)
const decodeCount = Schema.decodeUnknownEffect(Schema.Tuple([CountRow]), strictParseOptions)
const decodeDurableExecutions = Schema.decodeUnknownEffect(Schema.Array(DurableExecutionRow), strictParseOptions)

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
    readonly reconciledAt: string
  }
  readonly startingCapitalMicros?: string
  readonly transactions: readonly AccountingTransaction[]
  readonly transactionEvidence: readonly ForwardPerformanceTransactionEvidence[]
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

const transactionQuery = (sql: PgClient.PgClient, accountId: string) => sql<Record<string, unknown>>`
  WITH latest_reconciliation AS (
    SELECT reconciled_at
    FROM reconciliations
    WHERE account_id = ${accountId}
    ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
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
  LEFT JOIN intents AS intent ON intent.intent_id = transaction.intent_id
  WHERE transaction.account_id = ${accountId}
    AND transaction.occurred_at <= latest_reconciliation.reconciled_at
  ORDER BY transaction.occurred_at, transaction.transaction_id COLLATE "C"
`

const receiptQuery = (sql: PgClient.PgClient, accountId: string) => sql<Record<string, unknown>>`
  WITH latest_reconciliation AS (
    SELECT reconciled_at
    FROM reconciliations
    WHERE account_id = ${accountId}
    ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
    LIMIT 1
  ), selected_transactions AS (
    SELECT broker_event_id
    FROM accounting_transactions
    CROSS JOIN latest_reconciliation
    WHERE account_id = ${accountId}
      AND occurred_at <= latest_reconciliation.reconciled_at
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

export const readForwardPerformancePostgres = (
  sql: PgClient.PgClient,
  accountId: string,
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
          FROM autonomous_cycles
          WHERE account_id = ${accountId}
            AND state IN ('COMPLETED', 'NO_TRADE')
          ORDER BY submission_open_at, cycle_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeCycles))

        const strategyRows = yield* sql<Record<string, unknown>>`
          WITH first_cycle AS (
            SELECT qualification_run_id, strategy_protocol_hash
            FROM autonomous_cycles
            WHERE account_id = ${accountId}
              AND state IN ('COMPLETED', 'NO_TRADE')
            ORDER BY submission_open_at, cycle_id COLLATE "C"
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
          SELECT reconciliation_id, content_hash, status, reconciled_at
          FROM reconciliations
          WHERE account_id = ${accountId}
          ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
          LIMIT 1
        `.pipe(Effect.flatMap(decodeReconciliation))

        const startingCapitalRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciled_at
            FROM reconciliations
            WHERE account_id = ${accountId}
            ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
            LIMIT 1
          ), first_cycle AS (
            SELECT submission_open_at
            FROM autonomous_cycles
            WHERE account_id = ${accountId}
              AND state IN ('COMPLETED', 'NO_TRADE')
            ORDER BY submission_open_at, cycle_id COLLATE "C"
            LIMIT 1
          )
          SELECT snapshot.equity_micros::text AS starting_capital_micros
          FROM account_snapshots AS snapshot
          JOIN broker_events AS event ON event.event_id = snapshot.event_id
          CROSS JOIN latest_reconciliation
          CROSS JOIN first_cycle
          WHERE snapshot.account_id = ${accountId}
            AND event.observed_at <= first_cycle.submission_open_at
            AND event.observed_at <= latest_reconciliation.reconciled_at
          ORDER BY event.observed_at DESC, event.source_sequence DESC, event.event_id COLLATE "C" DESC
          LIMIT 1
        `.pipe(Effect.flatMap(decodeStartingCapital))

        const transactionRows = yield* transactionQuery(sql, accountId).pipe(Effect.flatMap(decodeTransactions))
        const receiptRows = yield* receiptQuery(sql, accountId).pipe(Effect.flatMap(decodeReceipts))
        const receipts = yield* Effect.forEach(receiptRows, (row) =>
          decodeAccountingReceipt(accountingReceiptFromRow(row)),
        )
        const durableExecutionRows = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciled_at
            FROM reconciliations
            WHERE account_id = ${accountId}
            ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
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
          JOIN intents AS intent ON intent.intent_id = transaction.intent_id
          JOIN authority_generations AS generation
            ON generation.generation_hash = intent.authority_generation_hash
          WHERE transaction.account_id = ${accountId}
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
            AND cycle.state IN ('PENDING', 'ACTIVE')
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
            SELECT reconciled_at
            FROM reconciliations
            WHERE account_id = ${accountId}
            ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT count(*)::integer AS count
          FROM (
            SELECT transaction.transaction_id AS activity_id
            FROM accounting_transactions AS transaction
            CROSS JOIN latest_reconciliation
            WHERE transaction.account_id = ${accountId}
              AND transaction.occurred_at > latest_reconciliation.reconciled_at
            UNION ALL
            SELECT fill.event_id AS activity_id
            FROM fills AS fill
            JOIN broker_events AS event ON event.event_id = fill.event_id
            CROSS JOIN latest_reconciliation
            WHERE fill.account_id = ${accountId}
              AND event.occurred_at > latest_reconciliation.reconciled_at
              AND NOT EXISTS (
                SELECT 1
                FROM accounting_transactions AS transaction
                WHERE transaction.broker_event_id = fill.event_id
              )
          ) AS activity
        `.pipe(Effect.flatMap(decodeCount))

        const [openPositions] = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciled_at
            FROM reconciliations
            WHERE account_id = ${accountId}
            ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT count(*)::integer AS count
          FROM (
            SELECT transaction.symbol
            FROM accounting_transactions AS transaction
            CROSS JOIN latest_reconciliation
            WHERE transaction.account_id = ${accountId}
              AND transaction.occurred_at <= latest_reconciliation.reconciled_at
            GROUP BY transaction.symbol
            HAVING sum(transaction.quantity_delta_micros) <> 0
              OR sum(transaction.cost_basis_delta_micros) <> 0
          ) AS open_position
        `.pipe(Effect.flatMap(decodeCount))

        const [unaccountedFills] = yield* sql<Record<string, unknown>>`
          WITH latest_reconciliation AS (
            SELECT reconciled_at
            FROM reconciliations
            WHERE account_id = ${accountId}
            ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
            LIMIT 1
          )
          SELECT count(*)::integer AS count
          FROM fills AS fill
          JOIN broker_events AS event ON event.event_id = fill.event_id
          CROSS JOIN latest_reconciliation
          LEFT JOIN accounting_transactions AS transaction ON transaction.broker_event_id = fill.event_id
          LEFT JOIN accounting_receipts AS receipt ON receipt.broker_event_id = fill.event_id
          WHERE fill.account_id = ${accountId}
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
        const reconciliation =
          reconciliationRow === undefined
            ? undefined
            : {
                reconciliationId: reconciliationRow.reconciliation_id,
                contentHash: reconciliationRow.content_hash,
                status: reconciliationRow.status,
                reconciledAt: reconciliationRow.reconciled_at.toISOString(),
              }
        const transactions = transactionRows.map(accountingTransactionFromRow)
        const transactionEvidence = transactionRows.map(
          (row): ForwardPerformanceTransactionEvidence => ({
            transactionId: row.transaction_id,
            cycleId: row.cycle_id ?? '',
            side: row.side,
            feeMicros: row.fee_micros,
            realizedPnlMicros: row.realized_pnl_micros,
            occurredAt: row.occurred_at.toISOString(),
          }),
        )

        return {
          cycles,
          ...(strategy === undefined ? {} : { strategy }),
          ...(reconciliation === undefined ? {} : { reconciliation }),
          ...(startingCapitalRows[0] === undefined
            ? {}
            : { startingCapitalMicros: startingCapitalRows[0].starting_capital_micros }),
          transactions,
          transactionEvidence,
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
