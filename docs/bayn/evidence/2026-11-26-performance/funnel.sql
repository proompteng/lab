-- Frozen decision/inference/execution funnel for November 23-25, 2026.
-- Run on the read replica with psql -X -v ON_ERROR_STOP=1 -At -f funnel.sql.
-- Cycle counts, candidate requests, submitted intents, fills, and flat episodes
-- have different grains and must not be treated as one denominator.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '20s';

SELECT 'cycle_states', execution_session_date,
       CASE
         WHEN (created_at AT TIME ZONE 'America/New_York')::time < '09:30' THEN 'PREMARKET'
         WHEN (created_at AT TIME ZONE 'America/New_York')::time < '16:00' THEN 'REGULAR'
         ELSE 'AFTERHOURS'
       END AS session_band,
       state, terminal_reason, count(*)
FROM autonomous_cycles
WHERE execution_session_date >= '2026-11-23' AND execution_session_date <= '2026-11-25'
GROUP BY execution_session_date, session_band, state, terminal_reason
ORDER BY execution_session_date, session_band, state;

WITH c AS MATERIALIZED (
  SELECT * FROM autonomous_cycles
  WHERE execution_session_date >= '2026-11-23' AND execution_session_date <= '2026-11-25'
)
SELECT 'request_outcomes', c.execution_session_date,
       r.payload->'outcome'->>'status' AS outcome,
       r.payload->'outcome'->'completion'->'handoff'->'disposition'->>'status' AS disposition,
       r.payload->'outcome'->'completion'->'jev'->>'status' AS jev_status, count(*)
FROM c JOIN jev_evaluation_requests q USING (cycle_id)
LEFT JOIN jev_evaluation_receipts r USING (request_id)
GROUP BY c.execution_session_date, outcome, disposition, jev_status
ORDER BY c.execution_session_date, count(*) DESC;

WITH c AS MATERIALIZED (
  SELECT * FROM autonomous_cycles
  WHERE execution_session_date >= '2026-11-23' AND execution_session_date <= '2026-11-25'
)
SELECT 'inference_elapsed', c.execution_session_date, count(*),
       percentile_disc(.5) WITHIN GROUP (
         ORDER BY (r.payload->>'completedAt')::timestamptz - (r.payload->>'startedAt')::timestamptz
       ) AS median,
       percentile_disc(.95) WITHIN GROUP (
         ORDER BY (r.payload->>'completedAt')::timestamptz - (r.payload->>'startedAt')::timestamptz
       ) AS p95,
       count(*) FILTER (
         WHERE (r.payload->>'completedAt')::timestamptz > (q.payload->>'expiresAt')::timestamptz
       ) AS late_receipts
FROM c JOIN jev_evaluation_requests q USING (cycle_id)
JOIN jev_evaluation_receipts r USING (request_id)
GROUP BY c.execution_session_date ORDER BY c.execution_session_date;

SELECT 'risk_outcomes', (decided_at AT TIME ZONE 'America/New_York')::date AS session_date,
       outcome, reason_codes, count(*)
FROM risk_decisions
WHERE decided_at >= '2026-11-23T00:00:00Z' AND decided_at < '2026-11-26T00:00:00Z'
GROUP BY session_date, outcome, reason_codes ORDER BY session_date, outcome;

SELECT 'regular_expiry', c.created_at, c.terminal_at,
       b.payload->>'completedAt' AS batch_completed_at,
       (SELECT count(*) FROM jev_evaluation_requests r WHERE r.cycle_id = c.cycle_id) AS requests,
       (SELECT count(*) FROM jev_evaluation_receipts x
        JOIN jev_evaluation_requests r USING (request_id) WHERE r.cycle_id = c.cycle_id) AS receipts
FROM autonomous_cycles c LEFT JOIN jev_batch_plans p USING (cycle_id)
LEFT JOIN jev_batch_results b USING (batch_id)
WHERE c.execution_session_date = '2026-11-25' AND c.state = 'BLOCKED'
  AND (c.created_at AT TIME ZONE 'America/New_York')::time >= '09:30'
  AND (c.created_at AT TIME ZONE 'America/New_York')::time < '16:00'
ORDER BY c.created_at;

WITH tx AS MATERIALIZED (
  SELECT a.*, i.cycle_id FROM accounting_transactions a JOIN intents i USING (intent_id)
  WHERE occurred_at >= '2026-11-24T00:00:00Z' AND occurred_at < '2026-11-26T00:00:00Z'
), ep AS MATERIALIZED (
  SELECT cycle_id, symbol, min(occurred_at) AS first_fill,
         sum(realized_pnl_micros) / 1e6 AS pnl
  FROM tx GROUP BY cycle_id, symbol
), joined AS MATERIALIZED (
  SELECT e.*, s.document->'targetPlan'->'intentTargets'->0->>'side' AS side
  FROM ep e JOIN autonomous_cycle_shadow_decisions s USING (cycle_id)
)
SELECT 'symbol_side', (first_fill AT TIME ZONE 'America/New_York')::date AS session_date,
       symbol, side, count(*), count(*) FILTER (WHERE pnl > 0), sum(pnl), max(pnl), min(pnl)
FROM joined GROUP BY session_date, symbol, side ORDER BY session_date, sum(pnl);

SELECT 'request_protocol', c.execution_session_date,
       q.payload->'request'->'protocol'->>'schemaVersion' AS protocol_version, count(*)
FROM autonomous_cycles c JOIN jev_evaluation_requests q USING (cycle_id)
WHERE c.execution_session_date >= '2026-11-16' AND c.execution_session_date < '2026-11-26'
GROUP BY c.execution_session_date, protocol_version ORDER BY c.execution_session_date, protocol_version;
COMMIT;
