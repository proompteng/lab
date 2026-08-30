import { PgClient } from '@effect/sql-pg'
import { generationScope, ledgerReplayBoundary, openingSnapshotBoundary } from './scope'

export const transactionQuery = (
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

export const ledgerTransactionQuery = (
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
    AND transaction.occurred_at <= ${ledgerReplayBoundary(sql)}
  ORDER BY transaction.occurred_at, transaction.transaction_id COLLATE "C"
`

export const receiptQuery = (
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

export const ledgerReceiptQuery = (
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
  JOIN accounting_transactions AS transaction USING (broker_event_id)
  CROSS JOIN latest_reconciliation
  WHERE transaction.account_id = ${accountId}
    AND transaction.occurred_at <= ${ledgerReplayBoundary(sql)}
  ORDER BY receipt.broker_event_id COLLATE "C"
`
