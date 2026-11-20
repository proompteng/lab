-- psql -X -v source_revision=<verified deployed SHA> -v start_at=<UTC> -v end_at=<UTC> \
--   -f tools/canonical-fill-latency.sql
-- Read-only account-scoped evidence. Verify the deployed revision covered the entire window separately:
-- broker_events do not retain a per-event build revision. Order history timestamps are NOT fill clocks.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL timezone = 'UTC';
SELECT (:'source_revision' ~ '^[a-f0-9]{40}$'
  AND :'start_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
  AND :'end_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
  AND :'end_at'::timestamptz > :'start_at'::timestamptz
  AND :'end_at'::timestamptz - :'start_at'::timestamptz <= interval '1 hour'
  AND :'end_at'::timestamptz <= transaction_timestamp()) AS valid_window \gset
\if :valid_window
\else
  DO $$ BEGIN
    RAISE EXCEPTION 'Invalid revision or window: require a full SHA and a completed window of at most one hour';
  END $$;
\endif

WITH scope AS MATERIALIZED (
  SELECT account_id FROM broker_observations WHERE source_revision = :'source_revision'
), events AS MATERIALIZED (
  SELECT event.event_id, event.source_event_id, event.account_id, event.occurred_at, event.observed_at,
    fill.fill_id, fill.broker_order_id,
    transaction.transaction_id, transaction.ledger_plan_hash,
    receipt.receipt_id, receipt.recorded_at, receipt.transfer_ids::text[] AS transfer_ids,
    extract(epoch FROM event.observed_at - event.occurred_at) * 1000 AS latency_ms
  FROM broker_events AS event
  JOIN scope USING (account_id)
  LEFT JOIN fills AS fill ON fill.event_id = event.event_id
  LEFT JOIN accounting_transactions AS transaction ON transaction.broker_event_id = event.event_id
  LEFT JOIN accounting_receipts AS receipt ON receipt.broker_event_id = event.event_id
  WHERE event.event_kind = 'FILL'
    AND (SELECT count(*) FROM scope) = 1
    AND event.occurred_at >= :'start_at'::timestamptz AND event.occurred_at < :'end_at'::timestamptz
  ORDER BY event.occurred_at, event.event_id
  LIMIT 1001
), summary AS (
  SELECT count(*) AS samples, count(*) FILTER (WHERE latency_ms < 0) AS invalid_clocks,
    count(*) FILTER (WHERE fill_id IS NULL) AS missing_fills,
    count(*) FILTER (WHERE receipt_id IS NULL) AS missing_accounting_receipts,
    count(*) - count(DISTINCT (account_id, source_event_id)) AS repeated_source_identities,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS median_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
    max(latency_ms) AS maximum_ms,
    percentile_cont(0.95) WITHIN GROUP (
      ORDER BY extract(epoch FROM recorded_at - observed_at) * 1000
    ) AS observation_to_accounting_p95_ms
  FROM events
)
SELECT jsonb_build_object(
  'schemaVersion', 'bayn.canonical-fill-latency.v1',
  'queriedAt', transaction_timestamp(),
  'accountScopeRevision', :'source_revision',
  'accountId', (SELECT min(account_id) FROM scope HAVING count(*) = 1),
  'startAt', :'start_at'::timestamptz, 'endAtExclusive', :'end_at'::timestamptz,
  'status', CASE
    WHEN (SELECT count(*) FROM scope) <> 1 THEN 'UNMEASURED_ACCOUNT_SCOPE'
    WHEN samples = 0 THEN 'UNMEASURED_NO_FILLS'
    WHEN samples > 1000 THEN 'UNMEASURED_ROW_LIMIT'
    WHEN invalid_clocks > 0 OR missing_fills > 0 THEN 'INVALID_EVIDENCE'
    ELSE 'MEASURED' END,
  'summary', to_jsonb(summary),
  'unmeasuredSegments', jsonb_build_array(
    'provider_publication', 'notification_to_fill_identity', 'durable_wake_to_capture_identity',
    'exclusive_owner_wait', 'per_fill_quota_wait', 'per_fill_materialization',
    'missing_provider_events', 'per_event_source_revision', 'independent_ledger_readback'
  ),
  'events', CASE WHEN samples BETWEEN 1 AND 1000 THEN (
    SELECT jsonb_agg(jsonb_build_object(
      'eventId', event_id, 'sourceEventId', source_event_id, 'fillId', fill_id,
      'brokerOrderId', broker_order_id, 'sourceAt', occurred_at, 'firstObservedAt', observed_at,
      'transactionId', transaction_id, 'ledgerPlanHash', ledger_plan_hash,
      'receiptId', receipt_id, 'accountedAt', recorded_at, 'transferIds', transfer_ids
    ) ORDER BY occurred_at, event_id) FROM events
  ) ELSE '[]'::jsonb END
) FROM summary;
COMMIT;
