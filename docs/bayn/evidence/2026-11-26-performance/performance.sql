-- Fixed Bayn PAPER performance evidence cut.
-- Source inspected: d6316076f3668423dab04d6b65f3e95fd4da60fb.
-- Execute on the verified read replica with:
-- psql -X -v ON_ERROR_STOP=1 -U postgres -d bayn -At -f performance.sql
-- One account was verified across this cohort. Re-scope before reuse if that changes.
-- All amounts are USD. Dates below use America/New_York for executions.
-- Fee dates are broker economic dates; inference values are list-rate estimates.
-- No account IDs, credentials, mutations, or individual broker order IDs are emitted.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '25s';

SELECT 'source_freshness', clock_timestamp(), pg_is_in_recovery(),
       pg_last_xact_replay_timestamp(), now() - pg_last_xact_replay_timestamp();

SELECT 'account_scope', count(DISTINCT account_id), count(*)
FROM accounting_transactions
WHERE occurred_at >= '2026-11-16T00:00:00Z'
  AND occurred_at < '2026-11-26T00:00:00Z';

-- Daily columns: session, episodes, wins, losses, fills, gross, broker_fee_debit,
-- broker_net, estimated_inference, unknown_inference_stages, known_cost_estimate,
-- win_sum, loss_sum, total_two_way_notional, unbalanced_episodes.
WITH tx AS MATERIALIZED (
  SELECT a.*, i.cycle_id
  FROM accounting_transactions a JOIN intents i USING (intent_id)
  WHERE occurred_at >= '2026-11-16T00:00:00Z'
    AND occurred_at < '2026-11-26T00:00:00Z'
), episodes AS MATERIALIZED (
  SELECT cycle_id, symbol, min(occurred_at) AS first_fill,
         count(*) AS fills, sum(realized_pnl_micros) / 1e6 AS gross,
         sum(notional_micros) / 1e6 AS notional,
         sum(quantity_delta_atoms) AS residual
  FROM tx GROUP BY cycle_id, symbol
), daily AS (
  SELECT (first_fill AT TIME ZONE 'America/New_York')::date AS session_date,
         count(*) AS episodes, count(*) FILTER (WHERE gross > 0) AS wins,
         count(*) FILTER (WHERE gross < 0) AS losses, sum(fills) AS fills,
         sum(gross) AS gross, sum(notional) AS notional,
         sum(gross) FILTER (WHERE gross > 0) AS win_sum,
         sum(gross) FILTER (WHERE gross < 0) AS loss_sum,
         count(*) FILTER (WHERE residual <> 0) AS unbalanced
  FROM episodes GROUP BY session_date
), fees AS (
  SELECT fee_date AS session_date, -sum(net_amount_micros) / 1e6 AS fee
  FROM broker_fee_accounting
  WHERE fee_date >= '2026-11-16' AND fee_date < '2026-11-26'
    AND posted_at < '2026-11-26T08:40:00Z'
  GROUP BY fee_date
), latest_quotes AS MATERIALIZED (
  SELECT DISTINCT ON (request_id, provider_stage) *
  FROM inference_expense_quotes
  WHERE session_date >= '2026-11-16' AND session_date < '2026-11-26'
    AND created_at < '2026-11-26T08:40:00Z'
  ORDER BY request_id, provider_stage, created_at DESC, quote_hash DESC
), inference AS (
  SELECT session_date,
         sum((payload->'line'->>'estimatedCostPicoUsd')::numeric) / 1e12 AS estimate,
         count(*) FILTER (WHERE payload->'line'->>'usageStatus' = 'UNKNOWN_USAGE') AS unknown_stages
  FROM latest_quotes GROUP BY session_date
), days AS (
  SELECT session_date FROM daily UNION SELECT session_date FROM fees
  UNION SELECT session_date FROM inference
)
SELECT 'daily', d.session_date, coalesce(t.episodes, 0), coalesce(t.wins, 0),
       coalesce(t.losses, 0), coalesce(t.fills, 0), coalesce(t.gross, 0),
       coalesce(f.fee, 0), coalesce(t.gross, 0) - coalesce(f.fee, 0),
       coalesce(i.estimate, 0), coalesce(i.unknown_stages, 0),
       coalesce(t.gross, 0) - coalesce(f.fee, 0) - coalesce(i.estimate, 0),
       coalesce(t.win_sum, 0), coalesce(t.loss_sum, 0), coalesce(t.notional, 0),
       coalesce(t.unbalanced, 0)
FROM days d LEFT JOIN daily t USING (session_date)
LEFT JOIN fees f USING (session_date) LEFT JOIN inference i USING (session_date)
ORDER BY d.session_date;

-- Daily fill tie-out columns: fills, accounting rows, ledger receipts,
-- quantity/price mismatches, unique event IDs, unique provider fill IDs.
WITH f AS MATERIALIZED (
  SELECT * FROM fills
  WHERE source_timestamp::timestamptz >= '2026-11-16T00:00:00Z'
    AND source_timestamp::timestamptz < '2026-11-26T00:00:00Z'
)
SELECT 'fill_coverage',
       (f.source_timestamp::timestamptz AT TIME ZONE 'America/New_York')::date AS session_date,
       count(*), count(t.broker_event_id), count(a.broker_event_id),
       count(*) FILTER (WHERE t.quantity_atoms IS DISTINCT FROM f.quantity_atoms
                           OR t.price_atoms IS DISTINCT FROM f.price_atoms),
       count(DISTINCT f.event_id), count(DISTINCT f.fill_id)
FROM f LEFT JOIN accounting_transactions t ON t.broker_event_id = f.event_id
LEFT JOIN accounting_receipts a ON a.broker_event_id = f.event_id
GROUP BY session_date ORDER BY session_date;

SELECT 'broker_fee', fee_date, count(*), sum(net_amount_micros) / 1e6, max(posted_at)
FROM broker_fee_accounting
WHERE fee_date >= '2026-11-16' AND fee_date < '2026-11-26'
  AND posted_at < '2026-11-26T08:40:00Z'
GROUP BY fee_date ORDER BY fee_date;

SELECT 'cash_start', b.occurred_at, a.cash_micros / 1e6, a.equity_micros / 1e6
FROM account_snapshots a JOIN broker_events b USING (event_id)
WHERE b.occurred_at >= '2026-11-16T00:00:00Z'
ORDER BY b.occurred_at LIMIT 1;

SELECT 'cash_end', b.occurred_at, a.cash_micros / 1e6, a.equity_micros / 1e6
FROM account_snapshots a JOIN broker_events b USING (event_id)
WHERE b.occurred_at < '2026-11-26T08:40:00Z'
ORDER BY b.occurred_at DESC LIMIT 1;

SELECT 'strategy_cohort', execution_session_date, strategy_name, strategy_protocol_hash,
       count(*), min(created_at), max(created_at)
FROM autonomous_cycles
WHERE execution_session_date >= '2026-11-16' AND execution_session_date < '2026-11-26'
GROUP BY execution_session_date, strategy_name, strategy_protocol_hash
ORDER BY execution_session_date, min(created_at);

SELECT 'current_authority', a.maximum, a.effective, a.kill_state, a.updated_at,
       g.strategy_name, g.activation_source_revision, g.activated_at,
       g.strategy_parameter_schema_version, g.strategy_protocol_hash
FROM authority_state a JOIN authority_generations g USING (generation_hash);

SELECT 'post_activation_cycles', count(*)
FROM autonomous_cycles
WHERE created_at >= (
  SELECT g.activated_at FROM authority_state a JOIN authority_generations g USING (generation_hash)
);
COMMIT;
