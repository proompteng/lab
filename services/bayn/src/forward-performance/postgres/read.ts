import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import { decodeAccountingReceipt } from '../../execution/contracts'
import { accountingReceiptFromRow, accountingTransactionFromRow } from '../../db/accounting-rows'
import type {
  ForwardPerformanceCashYieldEvidence,
  ForwardPerformanceCycleEvidence,
  ForwardPerformanceStrategyEvidence,
  ForwardPerformanceTransactionEvidence,
} from '../model'
import { Pipeable } from '../../pipeable'
import {
  ForwardPerformancePostgresError,
  type ForwardPerformancePostgresEvidence,
  decodeCashYieldEvidence,
  decodeCount,
  decodeCycleDecisions,
  decodeCycles,
  decodeDurableExecutions,
  decodeExecutionFills,
  decodeExecutionIntents,
  decodeExecutionOrders,
  decodeMarketVolumeBindings,
  decodeReceipts,
  decodeReconciliation,
  decodeStartingCapital,
  decodeStrategy,
  decodeTransactions,
  postgresError,
} from './model'
import { closingSnapshotBoundary, generationScope, openingSnapshotBoundary, reconciliationExactness } from './scope'
import { ledgerReceiptQuery, ledgerTransactionQuery, receiptQuery, transactionQuery } from './queries'
import { executionEvidenceFromRows, marketVolumeRequestsFromRows } from './projection'

export const readForwardPerformancePostgresDataFirst = (
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
            SELECT qualification_run_id, strategy_protocol_hash, created_at
            FROM autonomous_cycles AS cycle
            WHERE cycle.account_id = ${accountId}
              AND cycle.state IN ('COMPLETED', 'NO_TRADE')
              AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
            ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
            LIMIT 1
          ), qualified_strategy AS (
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
          ), research_strategy AS (
            SELECT
              generation.research_plan_hash AS qualification_run_id,
              generation.strategy_name,
              generation.strategy_protocol_hash,
              generation.strategy_behavior_hash,
              generation.strategy_parameter_hash,
              generation.strategy_parameter_schema_version,
              generation.activation_source_revision AS source_revision,
              generation.activation_image_repository AS image_repository,
              generation.activation_image_digest AS image_digest
            FROM first_cycle
            JOIN authority_generations AS generation
              ON generation.activation_schema_version = 'bayn.paper-authority-generation.v3'
              AND generation.maximum = 'PAPER'
              AND generation.account_id = ${accountId}
              AND generation.research_plan_hash = first_cycle.qualification_run_id
              AND generation.strategy_protocol_hash = first_cycle.strategy_protocol_hash
              AND first_cycle.created_at >= generation.activated_at
            WHERE ${
              authorityGenerationHash === undefined
                ? true
                : sql`generation.generation_hash = ${authorityGenerationHash}`
            }
              AND NOT EXISTS (
                SELECT 1
                FROM authority_generations AS next_generation
                WHERE next_generation.previous_generation_hash = generation.generation_hash
                  AND first_cycle.created_at >= next_generation.activated_at
              )
          )
          SELECT * FROM qualified_strategy
          UNION ALL
          SELECT * FROM research_strategy
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
          ), baseline_snapshot AS (
            SELECT
              opening_snapshot.event_id,
              opening_snapshot.observed_at,
              opening_snapshot.cash_micros
            FROM opening_snapshot
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
              AND event.observed_at <= ${closingSnapshotBoundary(sql, accountId, authorityGenerationHash)}
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
        const ledgerTransactionRows = yield* ledgerTransactionQuery(sql, accountId, authorityGenerationHash).pipe(
          Effect.flatMap(decodeTransactions),
        )
        const receiptRows = yield* receiptQuery(sql, accountId, authorityGenerationHash).pipe(
          Effect.flatMap(decodeReceipts),
        )
        const ledgerReceiptRows = yield* ledgerReceiptQuery(sql, accountId, authorityGenerationHash).pipe(
          Effect.flatMap(decodeReceipts),
        )
        const receipts = yield* Effect.forEach(receiptRows, (row) =>
          decodeAccountingReceipt(accountingReceiptFromRow(row)),
        )
        const ledgerReceipts = yield* Effect.forEach(ledgerReceiptRows, (row) =>
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
          SELECT decision_rows.cycle_id, decision_rows.decision_hash, decision_rows.document, decision_rows.created_at
          FROM (
            SELECT
              cycle.cycle_id,
              decision.decision_hash,
              decision.document,
              decision.created_at
            FROM autonomous_cycles AS cycle
            JOIN autonomous_cycle_shadow_decisions AS decision
              ON decision.cycle_id = cycle.cycle_id
              AND decision.decision_hash = cycle.decision_hash
            WHERE decision.schema_version IN ('bayn.observe-shadow-decision.v1', 'bayn.paper-cycle-decision.v1')
            UNION ALL
            SELECT
              cycle.cycle_id,
              closure.document #>> '{document,contentHash}' AS decision_hash,
              closure.document -> 'document' AS document,
              (closure.document ->> 'createdAt')::timestamptz AS created_at
            FROM autonomous_cycles AS cycle
            JOIN autonomous_cycle_paper_closures AS closure ON closure.cycle_id = cycle.cycle_id
            WHERE closure.document #>> '{document,schemaVersion}' = 'bayn.paper-cycle-decision.v1'
            UNION ALL
            SELECT
              cycle.cycle_id,
              replan.document #>> '{document,contentHash}' AS decision_hash,
              replan.document -> 'document' AS document,
              (replan.document ->> 'createdAt')::timestamptz AS created_at
            FROM autonomous_cycles AS cycle
            JOIN autonomous_cycle_paper_close_replans AS replan ON replan.cycle_id = cycle.cycle_id
            WHERE replan.document #>> '{document,schemaVersion}' = 'bayn.paper-cycle-decision.v1'
          ) AS decision_rows
          JOIN autonomous_cycles AS cycle ON cycle.cycle_id = decision_rows.cycle_id
          CROSS JOIN latest_reconciliation
          WHERE cycle.account_id = ${accountId}
            AND cycle.state = 'COMPLETED'
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
            AND cycle.terminal_at <= latest_reconciliation.reconciled_at
          ORDER BY decision_rows.cycle_id COLLATE "C", decision_rows.created_at, decision_rows.decision_hash COLLATE "C"
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
            intent.notional_limit_micros::text AS notional_limit_micros,
            intent.replan_generation_hash,
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
            observed_order.notional_micros::text AS notional_micros,
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
            COALESCE(generation.qualification_run_id, generation.research_plan_hash) AS qualification_run_id,
            generation.strategy_name,
            COALESCE(generation.protocol_hash, generation.strategy_protocol_hash) AS protocol_hash,
            generation.strategy_behavior_hash,
            generation.strategy_parameter_hash,
            generation.strategy_parameter_schema_version,
            COALESCE(generation.qualification_execution_policy_hash, cycle.execution_policy_hash)
              AS qualification_execution_policy_hash,
            COALESCE(generation.qualification_source_revision, generation.activation_source_revision)
              AS qualification_source_revision,
            COALESCE(generation.qualification_image_repository, generation.activation_image_repository)
              AS qualification_image_repository,
            COALESCE(generation.qualification_image_digest, generation.activation_image_digest)
              AS qualification_image_digest
          FROM accounting_transactions AS transaction
          CROSS JOIN latest_reconciliation
          CROSS JOIN opening_snapshot
          JOIN intents AS intent ON intent.intent_id = transaction.intent_id
          JOIN autonomous_cycles AS cycle
            ON cycle.cycle_id = intent.cycle_id
            AND cycle.account_id = intent.account_id
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
            COALESCE(generation.qualification_run_id, generation.research_plan_hash),
            generation.strategy_name,
            COALESCE(generation.protocol_hash, generation.strategy_protocol_hash),
            generation.strategy_behavior_hash,
            generation.strategy_parameter_hash,
            generation.strategy_parameter_schema_version,
            COALESCE(generation.qualification_execution_policy_hash, cycle.execution_policy_hash),
            COALESCE(generation.qualification_source_revision, generation.activation_source_revision),
            COALESCE(generation.qualification_image_repository, generation.activation_image_repository),
            COALESCE(generation.qualification_image_digest, generation.activation_image_digest)
        `.pipe(Effect.flatMap(decodeDurableExecutions))

        const [unclosedCycles] = yield* sql<Record<string, unknown>>`
          SELECT count(*)::integer AS count
          FROM autonomous_cycles AS cycle
          WHERE cycle.account_id = ${accountId}
            -- A terminally blocked execution cycle is terminal evidence of an incomplete generation.
            -- Count it as unclosed so an earlier successful cycle cannot produce a sufficient receipt.
            AND cycle.state IN ('PENDING', 'ACTIVE', 'BLOCKED')
            AND ${generationScope(sql, accountId, authorityGenerationHash, 'unclosed-cycle')}
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
        const ledgerTransactions = ledgerTransactionRows.map(accountingTransactionFromRow)
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
          ledgerTransactions,
          transactionEvidence,
          executionEvidence,
          marketVolumeRequests,
          receipts,
          ledgerReceipts,
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

export const readForwardPerformancePostgres = Pipeable.by<
  (
    accountId: string,
    authorityGenerationHash?: string,
  ) => (sql: PgClient.PgClient) => ReturnType<typeof readForwardPerformancePostgresDataFirst>,
  typeof readForwardPerformancePostgresDataFirst
>((arguments_) => typeof arguments_[0] !== 'string', readForwardPerformancePostgresDataFirst)
