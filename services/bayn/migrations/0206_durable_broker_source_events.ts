import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // A published broker cut is not yet safe for stream fill accounting. Canonical reconciliation advances this
  // watermark only after the cut's complete history has been ingested and its financial state is exact.
  yield* sql`ALTER TABLE broker_observations ADD COLUMN financial_reconciliation_fence_at timestamptz`
  // Order current-state selection must use Alpaca's full provider version, not local arrival order or PostgreSQL's
  // lower timestamp precision. Every historical source identity already retains that version; materialize its canonical
  // nine-digit form once so stream and snapshot ingestion share one monotonic boundary.
  yield* sql`ALTER TABLE orders ADD COLUMN broker_updated_at text`
  // The evidence table is normally immutable. Open only the existing UPDATE/DELETE guard for this one deterministic
  // materialization; the migration transaction restores it before any new schema can become visible.
  yield* sql`ALTER TABLE orders DISABLE TRIGGER orders_append_only`
  yield* sql`WITH versions AS (
    SELECT observed.event_id,
      parts[1] || '.' || rpad(COALESCE(parts[2], ''),9,'0') || 'Z' AS broker_updated_at
    FROM orders AS observed
    JOIN broker_events AS event USING (event_id)
    CROSS JOIN LATERAL regexp_match(
      event.source_event_id,
      '([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:[.]([0-9]{1,9}))?Z$'
    ) AS parts
  )
  UPDATE orders AS observed SET broker_updated_at = versions.broker_updated_at
  FROM versions WHERE versions.event_id = observed.event_id`
  yield* sql`ALTER TABLE orders ENABLE TRIGGER orders_append_only`
  yield* sql`ALTER TABLE orders ALTER COLUMN broker_updated_at SET NOT NULL`
  yield* sql`ALTER TABLE orders ADD CONSTRAINT orders_broker_updated_at_check CHECK (
    broker_updated_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$'
  )`
  // Restate can keep a predecessor invocation alive while this revision starts. Put the provider-version invariant at
  // the shared database boundary so that predecessor inserts derive the required value and cannot append an older
  // order state. The compatibility branch is removed after the predecessor revision and its prepared statements drain.
  yield* sql`CREATE FUNCTION enforce_order_provider_version() RETURNS trigger AS $function$
  DECLARE
    source_id text;
    source_parts text[];
    canonical_updated_at text;
    current_updated_at text;
    current_source_id text;
  BEGIN
    SELECT source_event_id INTO source_id
    FROM broker_events
    WHERE event_id = NEW.event_id AND account_id = NEW.account_id AND event_kind = 'ORDER' AND broker = 'ALPACA';
    IF source_id IS NULL THEN
      RAISE EXCEPTION 'order event does not identify an ALPACA order source' USING ERRCODE = '23514';
    END IF;

    source_parts := regexp_match(
      source_id,
      '^(order:.*):([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:[.]([0-9]{1,9}))?Z$'
    );
    IF source_parts IS NULL OR source_parts[1] <> 'order:' || NEW.broker_order_id THEN
      RAISE EXCEPTION 'order source identity does not match the order payload' USING ERRCODE = '23514';
    END IF;
    canonical_updated_at := source_parts[2] || '.' || rpad(COALESCE(source_parts[3],''),9,'0') || 'Z';
    IF NEW.broker_updated_at IS NOT NULL THEN
      IF NEW.broker_updated_at <> canonical_updated_at THEN
        RAISE EXCEPTION 'order provider version does not match the source identity' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('ALPACA:' || NEW.account_id,0));
    SELECT observed.broker_updated_at,event.source_event_id
      INTO current_updated_at,current_source_id
    FROM orders AS observed
    JOIN broker_events AS event USING (event_id)
    WHERE observed.account_id = NEW.account_id AND observed.broker_order_id = NEW.broker_order_id
    ORDER BY observed.broker_updated_at COLLATE "C" DESC,event.source_sequence DESC,event.event_id COLLATE "C" DESC
    LIMIT 1;
    IF (current_updated_at COLLATE "C") > (canonical_updated_at COLLATE "C") THEN
      RAISE EXCEPTION 'order provider version is older than retained state' USING ERRCODE = '23514';
    END IF;
    IF current_updated_at = canonical_updated_at AND current_source_id <> source_id THEN
      RAISE EXCEPTION 'order provider version was reused with a different source identity' USING ERRCODE = '23514';
    END IF;

    NEW.broker_updated_at := canonical_updated_at;
    RETURN NEW;
  END
  $function$ LANGUAGE plpgsql`
  yield* sql`CREATE TRIGGER orders_provider_version
    BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION enforce_order_provider_version()`
  yield* sql`CREATE INDEX orders_current_provider_version
    ON orders(account_id,broker_order_id,broker_updated_at COLLATE "C" DESC)`
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
