-- Bayn PAPER retained lifetime account bridge, inspected source d6316076f3668423dab04d6b65f3e95fd4da60fb.
-- Execute: psql -X -v ON_ERROR_STOP=1 -U postgres -d bayn -At -f lifetime.sql
-- Fixed economic/account cutoff: 2026-11-26T09:04:15Z. Rows are current retained evidence at retrieval.
-- One account is verified below; scope explicitly before reuse against a multi-account database.
-- Archive rows overlap canonical history and MUST NOT be added to it.
-- USD throughout. No account IDs or broker/order identifiers are emitted.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '25s';

SELECT 'source_freshness', clock_timestamp(), pg_is_in_recovery(), pg_last_xact_replay_timestamp();
SELECT 'retained_fills', count(*), count(DISTINCT account_id),
       min(source_timestamp::timestamptz), max(source_timestamp::timestamptz),
       count(DISTINCT (source_timestamp::timestamptz AT TIME ZONE 'America/New_York')::date)
FROM fills WHERE source_timestamp::timestamptz < '2026-11-26T09:04:15Z';

SELECT 'first_account', b.occurred_at, a.cash_micros / 1e6, a.equity_micros / 1e6
FROM account_snapshots a JOIN broker_events b USING (event_id)
WHERE b.occurred_at < '2026-11-26T09:04:15Z' ORDER BY b.occurred_at LIMIT 1;
SELECT 'pre_first_fill_account', b.occurred_at, a.cash_micros / 1e6, a.equity_micros / 1e6
FROM account_snapshots a JOIN broker_events b USING (event_id)
WHERE b.occurred_at < (SELECT min(occurred_at) FROM accounting_transactions)
ORDER BY b.occurred_at DESC LIMIT 1;
SELECT 'last_account', b.occurred_at, a.cash_micros / 1e6, a.equity_micros / 1e6
FROM account_snapshots a JOIN broker_events b USING (event_id)
WHERE b.occurred_at < '2026-11-26T09:04:15Z' ORDER BY b.occurred_at DESC LIMIT 1;
SELECT 'first_position_snapshot', observed_at, position_count
FROM position_snapshots ORDER BY observed_at LIMIT 1;
SELECT 'last_position_snapshot', observed_at, position_count
FROM position_snapshots WHERE observed_at < '2026-11-26T09:04:15Z'
ORDER BY observed_at DESC LIMIT 1;
SELECT 'last_reconciliation', status, reconciled_at, jsonb_array_length(discrepancies)
FROM reconciliations WHERE reconciled_at < '2026-11-26T09:04:15Z'
ORDER BY reconciled_at DESC LIMIT 1;

-- Columns: fills, accounting rows, receipts, qty/price mismatches, unique events, unique provider fills.
SELECT 'fill_coverage', count(*), count(t.broker_event_id), count(a.broker_event_id),
       count(*) FILTER (WHERE t.quantity_atoms IS DISTINCT FROM f.quantity_atoms
                           OR t.price_atoms IS DISTINCT FROM f.price_atoms),
       count(DISTINCT f.event_id), count(DISTINCT f.fill_id)
FROM fills f LEFT JOIN accounting_transactions t ON t.broker_event_id = f.event_id
LEFT JOIN accounting_receipts a ON a.broker_event_id = f.event_id
WHERE f.source_timestamp::timestamptz < '2026-11-26T09:04:15Z';

-- Two independently expressed bridges: cash flows and gross P&L less cash/coin fees.
-- Coin inventory cost is already in fill cash deltas and MUST NOT be subtracted twice from that bridge.
WITH tx AS (
  SELECT sum(realized_pnl_micros) AS gross, sum(fee_micros) AS embedded_fee,
         sum(cash_delta_micros) AS cash_delta, sum(cost_basis_delta_micros) AS residual_basis
  FROM accounting_transactions WHERE occurred_at < '2026-11-26T09:04:15Z'
), cash_fee AS (
  SELECT sum(cash_delta_micros) AS cash_delta FROM broker_cash_fee_deltas
  WHERE effective_at < '2026-11-26T09:04:15Z' AND posted_at < '2026-11-26T09:04:15Z'
), coin AS (
  SELECT sum(cost_basis_micros) AS expense FROM broker_inventory_debits
  WHERE effective_at < '2026-11-26T09:04:15Z' AND posted
), rounding AS (
  SELECT sum(rounding_delta_micros) AS delta FROM broker_cash_settlements
  WHERE posted_at < '2026-11-26T09:04:15Z'
), opening AS (
  SELECT cash_micros FROM account_snapshots a JOIN broker_events b USING (event_id)
  WHERE b.occurred_at < '2026-11-26T09:04:15Z' ORDER BY b.occurred_at LIMIT 1
), closing AS (
  SELECT cash_micros FROM account_snapshots a JOIN broker_events b USING (event_id)
  WHERE b.occurred_at < '2026-11-26T09:04:15Z' ORDER BY b.occurred_at DESC LIMIT 1
)
SELECT 'cash_bridge', opening.cash_micros / 1e6, tx.gross / 1e6, tx.embedded_fee / 1e6,
       tx.cash_delta / 1e6, cash_fee.cash_delta / 1e6, coin.expense / 1e6, rounding.delta / 1e6,
       closing.cash_micros / 1e6, (closing.cash_micros - opening.cash_micros) / 1e6,
       (closing.cash_micros - opening.cash_micros - tx.cash_delta - cash_fee.cash_delta - rounding.delta) / 1e6,
       (closing.cash_micros - opening.cash_micros - tx.gross + coin.expense - cash_fee.cash_delta - rounding.delta) / 1e6,
       (tx.residual_basis - coin.expense) / 1e6
FROM tx, cash_fee, coin, rounding, opening, closing;

SELECT 'fee_activity_kind',
       CASE WHEN data ? 'coinDebit' THEN 'COIN'
            WHEN data->>'cryptoCashFee' = 'true' THEN 'CRYPTO_CASH' ELSE 'FEE_CASH' END,
       count(*), sum(net_amount_micros) / 1e6, sum(coin_cost_basis_micros) / 1e6
FROM broker_fee_accounting WHERE posted_at < '2026-11-26T09:04:15Z'
GROUP BY 2 ORDER BY 2;
SELECT 'fee_accrual', kind, count(*), sum(cash_debit_micros) / 1e6, sum(expense_micros) / 1e6,
       count(*) FILTER (WHERE posted_at IS NULL)
FROM broker_fee_accruals WHERE observed_at < '2026-11-26T09:04:15Z' GROUP BY kind ORDER BY kind;
SELECT 'fee_cash_view', count(*), sum(cash_delta_micros) / 1e6
FROM broker_cash_fee_deltas
WHERE effective_at < '2026-11-26T09:04:15Z' AND posted_at < '2026-11-26T09:04:15Z';
SELECT 'rounding', count(*), sum(rounding_delta_micros) / 1e6, min(posted_at), max(posted_at)
FROM broker_cash_settlements WHERE posted_at < '2026-11-26T09:04:15Z';

-- Columns: symbol, fill-only quantity, posted coin fee quantity, net quantity,
-- fill-only residual cost basis USD, posted coin fee basis USD, net basis USD.
WITH tx AS (
  SELECT symbol, sum(quantity_delta_atoms) AS qty, sum(cost_basis_delta_micros) AS basis
  FROM accounting_transactions WHERE occurred_at < '2026-11-26T09:04:15Z' GROUP BY symbol
), debit AS (
  SELECT symbol, sum(quantity_atoms) AS qty, sum(cost_basis_micros) AS basis
  FROM broker_inventory_debits WHERE effective_at < '2026-11-26T09:04:15Z' AND posted GROUP BY symbol
)
SELECT 'inventory_bridge', symbol, tx.qty, coalesce(debit.qty, 0), tx.qty - coalesce(debit.qty, 0),
       tx.basis / 1e6, coalesce(debit.basis, 0) / 1e6, (tx.basis - coalesce(debit.basis, 0)) / 1e6
FROM tx LEFT JOIN debit USING (symbol) ORDER BY symbol;

-- Asset and symbol gross are realized accounting P&L, not episode counts or new-policy results.
SELECT 'asset_gross', CASE WHEN symbol LIKE '%/%' THEN 'CRYPTO' ELSE 'EQUITY' END,
       count(*), min(occurred_at), max(occurred_at), sum(realized_pnl_micros) / 1e6
FROM accounting_transactions WHERE occurred_at < '2026-11-26T09:04:15Z'
GROUP BY 2 ORDER BY 2;
SELECT 'symbol_gross', symbol, count(*), min(occurred_at), max(occurred_at),
       sum(realized_pnl_micros) / 1e6
FROM accounting_transactions WHERE occurred_at < '2026-11-26T09:04:15Z'
GROUP BY symbol ORDER BY sum(realized_pnl_micros), symbol;

SELECT 'daily_gross', (occurred_at AT TIME ZONE 'America/New_York')::date,
       count(*), sum(realized_pnl_micros) / 1e6
FROM accounting_transactions WHERE occurred_at < '2026-11-26T09:04:15Z'
GROUP BY 2 ORDER BY 2;
-- Fee economic dates need not be the execution dates above; avoid false daily net or drawdown estimates.
SELECT 'cash_fee_economic_date', fee_date, count(*), sum(net_amount_micros) / 1e6
FROM broker_fee_accounting WHERE posted_at < '2026-11-26T09:04:15Z'
GROUP BY fee_date ORDER BY fee_date;

-- Whole archive overlap proves these are historical copies, not additional executions.
SELECT 'archive_fill_overlap', count(*), count(f.event_id),
       count(*) FILTER (WHERE f.source_timestamp IS DISTINCT FROM x.original_record->>'source_timestamp'),
       min(x.original_record->>'source_timestamp'), max(x.original_record->>'source_timestamp')
FROM execution_unit_cutover_archive x LEFT JOIN fills f ON f.event_id = x.original_record->>'event_id'
WHERE x.table_name = 'fills';
SELECT 'archive_provider_fill_overlap', count(*), count(f.fill_id)
FROM execution_unit_cutover_archive x LEFT JOIN fills f ON f.fill_id = x.original_record->>'fill_id'
WHERE x.table_name = 'fills';
SELECT 'cycle_attribution', count(*), count(i.intent_id), count(c.cycle_id)
FROM accounting_transactions a LEFT JOIN intents i USING (intent_id)
LEFT JOIN autonomous_cycles c ON c.cycle_id = i.cycle_id
WHERE a.occurred_at < '2026-11-26T09:04:15Z';
COMMIT;

