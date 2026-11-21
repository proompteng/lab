import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Restate keeps the replaced worker revision while accepted invocations drain. Its only remaining write is the
  // retired identity receipt. Keep that physical table and its OID intact so even a prepared old-worker statement
  // cannot be redirected into the new payload contract. Current code has no caller for the old table; the post-cutover
  // migration merges any late rows and drops it.
  yield* sql`CREATE TABLE broker_source_events (
    account_id text NOT NULL,
    event_id text NOT NULL CHECK (event_id ~ '^[a-f0-9]{64}$'),
    source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
    received_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    event_kind text NOT NULL,
    session_id text,
    notification jsonb,
    PRIMARY KEY(account_id,event_id)
  )`
  yield* sql`ALTER TABLE broker_source_events ADD CONSTRAINT broker_source_events_payload_check CHECK (
    (event_kind = 'LEGACY_RECEIPT' AND session_id IS NULL AND notification IS NULL) OR
    (event_kind IN ('SessionReady','TradeUpdate') AND session_id IS NOT NULL AND session_id <> ''
      AND char_length(session_id) <= 100 AND notification IS NOT NULL AND jsonb_typeof(notification) = 'object')
  )`
  yield* sql`INSERT INTO broker_source_events(
    account_id,event_id,source_revision,received_at,recorded_at,event_kind
  ) SELECT account_id,event_id,source_revision,received_at,recorded_at,'LEGACY_RECEIPT'
    FROM broker_notification_receipts`
  yield* sql`CREATE INDEX broker_source_events_watermark
    ON broker_source_events(account_id,recorded_at DESC)`
  yield* sql`CREATE INDEX broker_source_events_session
    ON broker_source_events(account_id,session_id,recorded_at) WHERE session_id IS NOT NULL`
  yield* sql`CREATE TRIGGER broker_source_events_immutable
    BEFORE UPDATE OR DELETE ON broker_source_events
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_source_events_no_truncate
    BEFORE TRUNCATE ON broker_source_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TABLE broker_source_event_projections (
    account_id text NOT NULL,
    event_id text NOT NULL CHECK (event_id ~ '^[a-f0-9]{64}$'),
    source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
    outcome text NOT NULL CHECK (outcome IN ('CANONICALLY_COVERED','PROJECTED','RECONCILE_REQUIRED')),
    reason text,
    order_event_id text CHECK (order_event_id IS NULL OR order_event_id ~ '^[a-f0-9]{64}$'),
    fill_event_id text CHECK (fill_event_id IS NULL OR fill_event_id ~ '^[a-f0-9]{64}$'),
    observed_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(account_id,event_id),
    FOREIGN KEY(account_id,event_id) REFERENCES broker_source_events(account_id,event_id),
    CHECK (
      (outcome = 'CANONICALLY_COVERED' AND reason IS NULL AND order_event_id IS NULL
        AND fill_event_id IS NULL) OR
      (outcome = 'PROJECTED' AND reason IS NULL AND order_event_id IS NOT NULL) OR
      (outcome = 'RECONCILE_REQUIRED' AND reason IS NOT NULL AND order_event_id IS NULL
        AND fill_event_id IS NULL)
    )
  )`
  yield* sql`CREATE INDEX broker_source_event_projections_completed
    ON broker_source_event_projections(account_id,completed_at DESC)`
  // The retired transport retained only event identity and arrival time. Give every migrated receipt a terminal
  // projection decision so redelivery routes through canonical reconciliation instead of requiring an absent payload.
  yield* sql`INSERT INTO broker_source_event_projections(
    account_id,event_id,source_revision,outcome,reason,observed_at
  ) SELECT account_id,event_id,source_revision,'RECONCILE_REQUIRED','LEGACY_RECEIPT',received_at
    FROM broker_source_events WHERE event_kind = 'LEGACY_RECEIPT'`
  yield* sql`CREATE TRIGGER broker_source_event_projections_immutable
    BEFORE UPDATE OR DELETE ON broker_source_event_projections
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_source_event_projections_no_truncate
    BEFORE TRUNCATE ON broker_source_event_projections
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
