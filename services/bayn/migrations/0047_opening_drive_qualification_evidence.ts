import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE opening_drive_qualification_locks (
      lock_id text PRIMARY KEY CHECK (lock_id ~ '^[0-9a-f]{64}$'),
      candidate_key text NOT NULL UNIQUE CHECK (candidate_key ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.opening-drive.qualification-lock.v1'),
      source_revision text NOT NULL CHECK (source_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
      strategy_behavior_hash text NOT NULL CHECK (strategy_behavior_hash ~ '^[0-9a-f]{64}$'),
      protocol_hash text NOT NULL CHECK (protocol_hash ~ '^[0-9a-f]{64}$'),
      policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
      cost_model_hash text NOT NULL CHECK (cost_model_hash ~ '^[0-9a-f]{64}$'),
      evaluation_calendar_hash text NOT NULL CHECK (evaluation_calendar_hash ~ '^[0-9a-f]{64}$'),
      replay_version_graph_hash text NOT NULL CHECK (replay_version_graph_hash ~ '^[0-9a-f]{64}$'),
      first_session date NOT NULL,
      last_session date NOT NULL,
      prior_trial_receipt_hashes jsonb NOT NULL CHECK (jsonb_typeof(prior_trial_receipt_hashes) = 'array'),
      binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
      calendar jsonb NOT NULL CHECK (jsonb_typeof(calendar) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (first_session <= last_session),
      CHECK (binding ->> 'sourceRevision' = source_revision),
      CHECK (binding ->> 'strategyBehaviorHash' = strategy_behavior_hash),
      CHECK (binding ->> 'protocolHash' = protocol_hash),
      CHECK (binding ->> 'policyHash' = policy_hash),
      CHECK (binding ->> 'costModelHash' = cost_model_hash),
      CHECK (binding ->> 'evaluationCalendarHash' = evaluation_calendar_hash),
      CHECK (binding ->> 'replayVersionGraphHash' = replay_version_graph_hash),
      CHECK (binding -> 'priorTrialReceiptHashes' = prior_trial_receipt_hashes),
      CHECK (calendar ->> 'schemaVersion' = 'bayn.opening-drive.qualification-calendar.v1'),
      CHECK (calendar ->> 'contentHash' = evaluation_calendar_hash),
      CHECK ((calendar ->> 'firstSession')::date = first_session),
      CHECK ((calendar ->> 'lastSession')::date = last_session)
    )
  `

  yield* sql`
    CREATE TABLE opening_drive_qualification_replay_versions (
      lock_id text NOT NULL REFERENCES opening_drive_qualification_locks(lock_id) ON DELETE RESTRICT,
      session_date date NOT NULL,
      opening_request_hash text NOT NULL CHECK (opening_request_hash ~ '^[0-9a-f]{64}$'),
      exit_request_hash text NOT NULL CHECK (exit_request_hash ~ '^[0-9a-f]{64}$'),
      opening_request jsonb NOT NULL CHECK (jsonb_typeof(opening_request) = 'object'),
      exit_request jsonb NOT NULL CHECK (jsonb_typeof(exit_request) = 'object'),
      PRIMARY KEY (lock_id, session_date)
    )
  `

  yield* sql`
    CREATE TABLE opening_drive_qualification_results (
      lock_id text PRIMARY KEY REFERENCES opening_drive_qualification_locks(lock_id) ON DELETE RESTRICT,
      receipt_hash text NOT NULL UNIQUE CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
      verdict text NOT NULL CHECK (verdict IN ('QUALIFIED', 'REJECTED', 'INSUFFICIENT')),
      document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (document ->> 'schemaVersion' = 'bayn.opening-drive.qualification-receipt.v1'),
      CHECK (document ->> 'receiptHash' = receipt_hash),
      CHECK (document ->> 'verdict' = verdict)
    )
  `

  yield* sql`
    CREATE TABLE opening_drive_qualification_session_replays (
      lock_id text NOT NULL REFERENCES opening_drive_qualification_results(lock_id) ON DELETE RESTRICT,
      session_date date NOT NULL,
      receipt_hash text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
      document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
      PRIMARY KEY (lock_id, session_date),
      CHECK (document ->> 'schemaVersion' = 'bayn.opening-drive.session-replay.v1'),
      CHECK ((document ->> 'sessionDate')::date = session_date),
      CHECK (document ->> 'receiptHash' = receipt_hash)
    )
  `

  for (const table of [
    'opening_drive_qualification_locks',
    'opening_drive_qualification_replay_versions',
    'opening_drive_qualification_results',
    'opening_drive_qualification_session_replays',
  ] as const) {
    yield* sql.unsafe(
      `CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`,
    )
    yield* sql.unsafe(
      `CREATE TRIGGER ${table}_reject_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`,
    )
  }
})
