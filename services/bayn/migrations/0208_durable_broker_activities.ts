import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE broker_activity_events (
    account_id text NOT NULL,
    source_event_id text NOT NULL CHECK (source_event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    transport_event_id text NOT NULL CHECK (transport_event_id ~ '^[a-f0-9]{64}$'),
    source_event_hash text NOT NULL CHECK (source_event_hash ~ '^[a-f0-9]{64}$'),
    source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
    ref_id uuid NOT NULL,
    previous_ref_id uuid,
    activity_type text NOT NULL CHECK (activity_type <> '' AND char_length(activity_type) <= 32),
    session_id text NOT NULL CHECK (session_id <> '' AND char_length(session_id) <= 100),
    request_id text NOT NULL CHECK (request_id <> '' AND char_length(request_id) <= 200),
    received_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    activity_json text NOT NULL CHECK (activity_json <> ''),
    PRIMARY KEY(account_id,source_event_id),
    UNIQUE(account_id,transport_event_id)
  )`
  yield* sql`CREATE INDEX broker_activity_events_ref
    ON broker_activity_events(account_id,ref_id,source_event_id)`
  yield* sql`CREATE TRIGGER broker_activity_events_immutable
    BEFORE UPDATE OR DELETE ON broker_activity_events
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_activity_events_no_truncate
    BEFORE TRUNCATE ON broker_activity_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`

  yield* sql`CREATE TABLE broker_activity_event_projections (
    account_id text NOT NULL,
    source_event_id text NOT NULL CHECK (source_event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
    outcome text NOT NULL CHECK (
      outcome IN ('FILL','FEE','BUST','CANONICAL_ONLY','DUPLICATE','RECONCILE_REQUIRED')
    ),
    ref_id uuid NOT NULL,
    previous_ref_id uuid,
    fill jsonb,
    fee_key text,
    reason text,
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(account_id,source_event_id),
    FOREIGN KEY(account_id,source_event_id) REFERENCES broker_activity_events(account_id,source_event_id),
    CHECK (
      (outcome = 'FILL' AND fill IS NOT NULL AND jsonb_typeof(fill) = 'object'
        AND fee_key IS NULL AND reason IS NULL) OR
      (outcome = 'FEE' AND fill IS NULL AND fee_key IS NOT NULL AND fee_key <> '' AND reason IS NULL) OR
      (outcome = 'BUST' AND previous_ref_id IS NOT NULL AND fill IS NULL
        AND fee_key IS NULL AND reason IS NULL) OR
      (outcome = 'CANONICAL_ONLY' AND fill IS NULL AND fee_key IS NULL
        AND reason = 'OUTSIDE_FILL_FEE_VIEW') OR
      (outcome = 'DUPLICATE' AND previous_ref_id IS NULL
        AND fill IS NULL AND fee_key IS NULL AND reason IS NULL) OR
      (outcome = 'RECONCILE_REQUIRED' AND fill IS NULL AND fee_key IS NULL AND reason IS NOT NULL)
    )
  )`
  yield* sql`CREATE UNIQUE INDEX broker_activity_effect_ref
    ON broker_activity_event_projections(account_id,ref_id)
    WHERE outcome IN ('FILL','FEE','BUST','CANONICAL_ONLY')`
  yield* sql`CREATE UNIQUE INDEX broker_activity_reversal
    ON broker_activity_event_projections(account_id,previous_ref_id)
    WHERE previous_ref_id IS NOT NULL AND outcome IN ('FILL','FEE','BUST')`
  yield* sql`CREATE INDEX broker_activity_active_effects
    ON broker_activity_event_projections(account_id,outcome,source_event_id)`
  yield* sql`CREATE TRIGGER broker_activity_event_projections_immutable
    BEFORE UPDATE OR DELETE ON broker_activity_event_projections
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_activity_event_projections_no_truncate
    BEFORE TRUNCATE ON broker_activity_event_projections
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`

  yield* sql`CREATE TABLE broker_activity_cursors (
    account_id text PRIMARY KEY,
    source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
    last_source_event_id text CHECK (
      last_source_event_id IS NULL OR last_source_event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'
    ),
    last_source_event_hash text CHECK (
      last_source_event_hash IS NULL OR last_source_event_hash ~ '^[a-f0-9]{64}$'
    ),
    last_activity_received_at timestamptz,
    caught_up boolean NOT NULL DEFAULT false,
    covered_through_at timestamptz,
    fill_fee_complete boolean NOT NULL DEFAULT true,
    session_id text CHECK (session_id IS NULL OR (session_id <> '' AND char_length(session_id) <= 100)),
    request_id text CHECK (request_id IS NULL OR (request_id <> '' AND char_length(request_id) <= 200)),
    heartbeat_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
      (last_source_event_id IS NULL AND last_source_event_hash IS NULL AND last_activity_received_at IS NULL) OR
      (last_source_event_id IS NOT NULL AND last_source_event_hash IS NOT NULL
        AND last_activity_received_at IS NOT NULL)
    ),
    CHECK (
      (session_id IS NULL AND request_id IS NULL AND heartbeat_at IS NULL) OR
      (session_id IS NOT NULL AND request_id IS NOT NULL AND heartbeat_at IS NOT NULL)
    ),
    CHECK (
      (NOT caught_up AND covered_through_at IS NULL) OR
      (caught_up AND covered_through_at IS NOT NULL)
    )
  )`
})
