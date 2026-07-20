import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE bayn_protocol_locks (
      protocol_hash text PRIMARY KEY CHECK (protocol_hash ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (length(schema_version) > 0),
      strategy_name text NOT NULL CHECK (length(strategy_name) > 0),
      behavior_hash text NOT NULL CHECK (behavior_hash ~ '^[0-9a-f]{64}$'),
      parameter_hash text NOT NULL CHECK (parameter_hash ~ '^[0-9a-f]{64}$'),
      parameters jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    )
  `

  yield* sql`
    CREATE TABLE bayn_snapshot_references (
      snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (length(schema_version) > 0),
      database_name text NOT NULL CHECK (length(database_name) > 0),
      table_name text NOT NULL CHECK (length(table_name) > 0),
      dataset_version text NOT NULL CHECK (length(dataset_version) > 0),
      source text NOT NULL CHECK (length(source) > 0),
      source_feed text NOT NULL CHECK (length(source_feed) > 0),
      adjustment text NOT NULL CHECK (length(adjustment) > 0),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      row_count bigint NOT NULL CHECK (row_count > 0),
      first_session date NOT NULL,
      last_session date NOT NULL,
      manifest jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CHECK (first_session <= last_session)
    )
  `

  yield* sql`
    CREATE TABLE bayn_evaluation_runs (
      run_id text PRIMARY KEY CHECK (run_id ~ '^[0-9a-f]{64}$'),
      protocol_hash text NOT NULL REFERENCES bayn_protocol_locks(protocol_hash) ON DELETE RESTRICT,
      snapshot_id text NOT NULL REFERENCES bayn_snapshot_references(snapshot_id) ON DELETE RESTRICT,
      evaluation_schema_version text NOT NULL CHECK (length(evaluation_schema_version) > 0),
      source_revision text NOT NULL CHECK (source_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
      image_repository text NOT NULL CHECK (length(image_repository) > 0),
      image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
      strategy_name text NOT NULL CHECK (length(strategy_name) > 0),
      initial_capital_micros numeric(38, 0) NOT NULL CHECK (initial_capital_micros > 0),
      expected_artifact_count integer NOT NULL CHECK (expected_artifact_count > 0),
      expected_event_count integer NOT NULL CHECK (expected_event_count >= 0),
      expected_gate_count integer NOT NULL CHECK (expected_gate_count > 0),
      status text NOT NULL CHECK (status IN ('WRITING', 'COMPLETE')),
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      completed_at timestamptz,
      CHECK (
        (status = 'WRITING' AND completed_at IS NULL)
        OR (status = 'COMPLETE' AND completed_at IS NOT NULL)
      )
    )
  `

  yield* sql`
    CREATE TABLE bayn_evaluation_artifacts (
      run_id text NOT NULL REFERENCES bayn_evaluation_runs(run_id) ON DELETE RESTRICT,
      artifact_name text NOT NULL CHECK (length(artifact_name) > 0),
      schema_version text NOT NULL CHECK (length(schema_version) > 0),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      PRIMARY KEY (run_id, artifact_name)
    )
  `

  yield* sql`
    CREATE TABLE bayn_evaluation_events (
      run_id text NOT NULL REFERENCES bayn_evaluation_runs(run_id) ON DELETE RESTRICT,
      ordinal integer NOT NULL CHECK (ordinal >= 0),
      event_id text NOT NULL CHECK (event_id ~ '^[0-9a-f]{64}$'),
      event_kind text NOT NULL CHECK (event_kind IN ('decision', 'fill')),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      PRIMARY KEY (run_id, ordinal),
      UNIQUE (run_id, event_id)
    )
  `

  yield* sql`
    CREATE TABLE bayn_gate_outcomes (
      run_id text NOT NULL REFERENCES bayn_evaluation_runs(run_id) ON DELETE RESTRICT,
      ordinal integer NOT NULL CHECK (ordinal >= 0),
      gate_name text NOT NULL CHECK (length(gate_name) > 0),
      passed boolean NOT NULL,
      actual jsonb NOT NULL,
      required jsonb NOT NULL,
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      PRIMARY KEY (run_id, ordinal),
      UNIQUE (run_id, gate_name)
    )
  `

  yield* sql`
    CREATE TABLE bayn_status_history (
      sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id text NOT NULL REFERENCES bayn_evaluation_runs(run_id) ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN ('WRITING', 'COMPLETE')),
      detail jsonb NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      UNIQUE (run_id, status)
    )
  `

  yield* sql`CREATE INDEX bayn_status_history_run_sequence_idx ON bayn_status_history(run_id, sequence)`
})
