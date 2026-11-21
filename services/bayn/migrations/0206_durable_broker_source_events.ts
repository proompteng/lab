import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE broker_notification_receipts RENAME TO broker_source_events`
  yield* sql`ALTER TABLE broker_source_events RENAME CONSTRAINT broker_notification_receipts_pkey TO broker_source_events_pkey`
  yield* sql`ALTER INDEX broker_notification_receipts_watermark RENAME TO broker_source_events_watermark`
  yield* sql`ALTER TRIGGER broker_notification_receipts_immutable ON broker_source_events
    RENAME TO broker_source_events_immutable`
  yield* sql`ALTER TRIGGER broker_notification_receipts_no_truncate ON broker_source_events
    RENAME TO broker_source_events_no_truncate`
  yield* sql`ALTER TABLE broker_source_events
    ADD COLUMN event_kind text NOT NULL DEFAULT 'LEGACY_RECEIPT',
    ADD COLUMN session_id text,
    ADD COLUMN notification jsonb`
  yield* sql`ALTER TABLE broker_source_events ALTER COLUMN event_kind DROP DEFAULT`
  yield* sql`ALTER TABLE broker_source_events ADD CONSTRAINT broker_source_events_payload_check CHECK (
    (event_kind = 'LEGACY_RECEIPT' AND session_id IS NULL AND notification IS NULL) OR
    (event_kind IN ('SessionReady','TradeUpdate') AND session_id IS NOT NULL AND session_id <> ''
      AND char_length(session_id) <= 100 AND jsonb_typeof(notification) = 'object')
  )`
  yield* sql`CREATE INDEX broker_source_events_session
    ON broker_source_events(account_id,session_id,recorded_at) WHERE session_id IS NOT NULL`
  yield* sql`CREATE TABLE broker_source_event_projections (
    account_id text NOT NULL,
    event_id text NOT NULL CHECK (event_id ~ '^[a-f0-9]{64}$'),
    source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
    outcome text NOT NULL CHECK (outcome IN ('CANONICALLY_COVERED','PROJECTED','RECONCILE_REQUIRED')),
    reason text,
    order_event_id text CHECK (order_event_id IS NULL OR order_event_id ~ '^[a-f0-9]{64}$'),
    fill_event_id text CHECK (fill_event_id IS NULL OR fill_event_id ~ '^[a-f0-9]{64}$'),
    accounting_receipt_id text CHECK (accounting_receipt_id IS NULL OR accounting_receipt_id ~ '^[a-f0-9]{64}$'),
    observed_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(account_id,event_id),
    FOREIGN KEY(account_id,event_id) REFERENCES broker_source_events(account_id,event_id),
    CHECK (
      (outcome = 'CANONICALLY_COVERED' AND reason IS NULL AND order_event_id IS NULL
        AND fill_event_id IS NULL AND accounting_receipt_id IS NULL) OR
      (outcome = 'PROJECTED' AND reason IS NULL AND order_event_id IS NOT NULL) OR
      (outcome = 'RECONCILE_REQUIRED' AND reason IS NOT NULL AND order_event_id IS NULL
        AND fill_event_id IS NULL AND accounting_receipt_id IS NULL)
    ),
    CHECK (accounting_receipt_id IS NULL OR fill_event_id IS NOT NULL)
  )`
  yield* sql`CREATE INDEX broker_source_event_projections_completed
    ON broker_source_event_projections(account_id,completed_at DESC)`
  yield* sql`CREATE TRIGGER broker_source_event_projections_immutable
    BEFORE UPDATE OR DELETE ON broker_source_event_projections
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_source_event_projections_no_truncate
    BEFORE TRUNCATE ON broker_source_event_projections
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
