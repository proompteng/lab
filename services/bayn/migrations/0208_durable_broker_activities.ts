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

  yield* sql`CREATE TABLE broker_activity_source_conflicts (
    account_id text NOT NULL,
    source_event_id text NOT NULL CHECK (source_event_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    retained_source_event_hash text CHECK (
      retained_source_event_hash IS NULL OR retained_source_event_hash ~ '^[a-f0-9]{64}$'
    ),
    conflicting_source_event_hash text NOT NULL CHECK (conflicting_source_event_hash ~ '^[a-f0-9]{64}$'),
    transport_event_id text NOT NULL CHECK (transport_event_id ~ '^[a-f0-9]{64}$'),
    source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
    session_id text NOT NULL CHECK (session_id <> '' AND char_length(session_id) <= 100),
    request_id text NOT NULL CHECK (request_id <> '' AND char_length(request_id) <= 200),
    received_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    activity_json text NOT NULL CHECK (activity_json <> ''),
    PRIMARY KEY(account_id,source_event_id,conflicting_source_event_hash),
    UNIQUE(account_id,transport_event_id)
  )`
  yield* sql`CREATE TRIGGER broker_activity_source_conflicts_immutable
    BEFORE UPDATE OR DELETE ON broker_activity_source_conflicts
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_activity_source_conflicts_no_truncate
    BEFORE TRUNCATE ON broker_activity_source_conflicts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`

  yield* sql`CREATE TABLE broker_activity_coverage_receipts (
    account_id text NOT NULL,
    transport_event_id text NOT NULL CHECK (transport_event_id ~ '^[a-f0-9]{64}$'),
    source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
    session_id text NOT NULL CHECK (session_id <> '' AND char_length(session_id) <= 100),
    request_id text NOT NULL CHECK (request_id <> '' AND char_length(request_id) <= 200),
    received_at timestamptz NOT NULL,
    cursor text CHECK (cursor IS NULL OR cursor ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    replay_from_id text NOT NULL CHECK (replay_from_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    replay_until_id text NOT NULL CHECK (replay_until_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    event_count bigint NOT NULL CHECK (event_count >= 0),
    prefix_hash text NOT NULL CHECK (prefix_hash ~ '^[a-f0-9]{64}$'),
    range_request_hash text NOT NULL CHECK (range_request_hash ~ '^[a-f0-9]{64}$'),
    completion_hash text NOT NULL CHECK (completion_hash ~ '^[a-f0-9]{64}$'),
    observed_cursor text CHECK (observed_cursor IS NULL OR observed_cursor ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    observed_event_count bigint NOT NULL CHECK (observed_event_count >= 0),
    observed_prefix_hash text NOT NULL CHECK (observed_prefix_hash ~ '^[a-f0-9]{64}$'),
    observed_range_request_hash text NOT NULL CHECK (observed_range_request_hash ~ '^[a-f0-9]{64}$'),
    observed_completion_hash text NOT NULL CHECK (observed_completion_hash ~ '^[a-f0-9]{64}$'),
    status text NOT NULL CHECK (status IN ('COMPLETE','POISONED')),
    reason text CHECK (
      (status = 'COMPLETE' AND reason IS NULL) OR
      (status = 'POISONED' AND reason IN (
        'CATCHUP_CURSOR_MISMATCH','CATCHUP_BOUNDARY_CONFLICT','LATE_PUBLICATION'
      ))
    ),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(account_id,transport_event_id)
  )`
  yield* sql`CREATE INDEX broker_activity_coverage_status
    ON broker_activity_coverage_receipts(account_id,status,recorded_at)`
  yield* sql`CREATE TRIGGER broker_activity_coverage_receipts_immutable
    BEFORE UPDATE OR DELETE ON broker_activity_coverage_receipts
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_activity_coverage_receipts_no_truncate
    BEFORE TRUNCATE ON broker_activity_coverage_receipts
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
    coverage_status text NOT NULL DEFAULT 'UNPROVEN' CHECK (
      coverage_status IN ('UNPROVEN','COMPLETE','POISONED')
    ),
    replay_from_id text CHECK (replay_from_id IS NULL OR replay_from_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    replay_until_id text CHECK (replay_until_id IS NULL OR replay_until_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    bootstrap_session_id text CHECK (
      bootstrap_session_id IS NULL OR (bootstrap_session_id <> '' AND char_length(bootstrap_session_id) <= 100)
    ),
    bootstrap_request_id text CHECK (
      bootstrap_request_id IS NULL OR (bootstrap_request_id <> '' AND char_length(bootstrap_request_id) <= 200)
    ),
    bootstrap_event_count bigint CHECK (bootstrap_event_count IS NULL OR bootstrap_event_count >= 0),
    bootstrap_prefix_hash text CHECK (
      bootstrap_prefix_hash IS NULL OR bootstrap_prefix_hash ~ '^[a-f0-9]{64}$'
    ),
    range_request_hash text CHECK (range_request_hash IS NULL OR range_request_hash ~ '^[a-f0-9]{64}$'),
    completion_hash text CHECK (completion_hash IS NULL OR completion_hash ~ '^[a-f0-9]{64}$'),
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
      (coverage_status <> 'COMPLETE' AND replay_from_id IS NULL AND replay_until_id IS NULL
        AND bootstrap_session_id IS NULL AND bootstrap_request_id IS NULL
        AND bootstrap_event_count IS NULL AND bootstrap_prefix_hash IS NULL
        AND range_request_hash IS NULL AND completion_hash IS NULL) OR
      (coverage_status = 'COMPLETE' AND replay_from_id IS NOT NULL AND replay_until_id IS NOT NULL
        AND replay_from_id <= replay_until_id
        AND bootstrap_session_id IS NOT NULL AND bootstrap_request_id IS NOT NULL
        AND bootstrap_event_count IS NOT NULL AND bootstrap_prefix_hash IS NOT NULL
        AND range_request_hash IS NOT NULL AND completion_hash IS NOT NULL)
    )
  )`
})
