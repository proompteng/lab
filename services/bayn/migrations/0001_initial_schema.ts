import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

const appendOnlyEvidenceTables = [
  'protocol_locks',
  'snapshot_references',
  'evaluation_artifacts',
  'evaluation_events',
  'gate_outcomes',
  'status_history',
] as const

const appendOnlyQualificationTables = ['qualification_trials', 'qualification_locks', 'qualification_results'] as const

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE protocol_locks (
      protocol_hash text PRIMARY KEY CHECK (protocol_hash ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.risk-balanced-trend.protocol.v2'),
      strategy_name text NOT NULL CHECK (strategy_name = 'risk-balanced-trend'),
      behavior_hash text NOT NULL CHECK (behavior_hash ~ '^[0-9a-f]{64}$'),
      parameter_hash text NOT NULL CHECK (parameter_hash ~ '^[0-9a-f]{64}$'),
      parameters jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    )
  `

  yield* sql`
    CREATE TABLE snapshot_references (
      snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.finalized-snapshot.v3'),
      database_name text NOT NULL CHECK (database_name = 'signal'),
      table_name text NOT NULL CHECK (table_name = 'adjusted_daily_bars_v2'),
      dataset_version text NOT NULL CHECK (dataset_version = 'signal.adjusted-daily-snapshot.v2'),
      source text NOT NULL CHECK (source = 'alpaca'),
      source_feed text NOT NULL CHECK (source_feed = 'sip'),
      adjustment text NOT NULL CHECK (adjustment = 'all'),
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
    CREATE TABLE evaluation_runs (
      run_id text PRIMARY KEY CHECK (run_id ~ '^[0-9a-f]{64}$'),
      protocol_hash text NOT NULL REFERENCES protocol_locks(protocol_hash) ON DELETE RESTRICT,
      snapshot_id text NOT NULL REFERENCES snapshot_references(snapshot_id) ON DELETE RESTRICT,
      evaluation_schema_version text NOT NULL CHECK (evaluation_schema_version = 'bayn.evaluation.v6'),
      source_revision text NOT NULL CHECK (source_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
      image_repository text NOT NULL CHECK (length(image_repository) > 0),
      image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
      strategy_name text NOT NULL CHECK (strategy_name = 'risk-balanced-trend'),
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
    CREATE TABLE evaluation_artifacts (
      run_id text NOT NULL REFERENCES evaluation_runs(run_id) ON DELETE RESTRICT,
      artifact_name text NOT NULL CHECK (length(artifact_name) > 0),
      schema_version text NOT NULL CHECK (length(schema_version) > 0),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      PRIMARY KEY (run_id, artifact_name)
    )
  `

  yield* sql`
    CREATE TABLE evaluation_events (
      run_id text NOT NULL REFERENCES evaluation_runs(run_id) ON DELETE RESTRICT,
      ordinal integer NOT NULL CHECK (ordinal >= 0),
      event_id text NOT NULL CHECK (event_id ~ '^[0-9a-f]{64}$'),
      event_kind text NOT NULL CHECK (event_kind IN ('decision', 'fill', 'fee', 'cash-yield')),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      PRIMARY KEY (run_id, ordinal),
      UNIQUE (run_id, event_id)
    )
  `

  yield* sql`
    CREATE TABLE gate_outcomes (
      run_id text NOT NULL REFERENCES evaluation_runs(run_id) ON DELETE RESTRICT,
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
    CREATE TABLE status_history (
      sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id text NOT NULL REFERENCES evaluation_runs(run_id) ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN ('WRITING', 'COMPLETE')),
      detail jsonb NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      UNIQUE (run_id, status)
    )
  `

  yield* sql`CREATE INDEX status_history_run_sequence_idx ON status_history(run_id, sequence)`

  yield* sql`
    CREATE TABLE qualification_trials (
      run_id text PRIMARY KEY REFERENCES evaluation_runs(run_id) ON DELETE RESTRICT,
      schema_version text NOT NULL CHECK (schema_version = 'bayn.qualification-trial.v1'),
      disposition text NOT NULL CHECK (disposition = 'BURNED'),
      reason_codes text[] NOT NULL CHECK (
        cardinality(reason_codes) > 0
        AND array_position(reason_codes, '') IS NULL
        AND array_position(reason_codes, NULL) IS NULL
      ),
      observed_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    )
  `

  yield* sql`
    CREATE TABLE qualification_locks (
      lock_id text PRIMARY KEY CHECK (lock_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.qualification-lock.v3'),
      candidate_run_id text NOT NULL UNIQUE CHECK (candidate_run_id ~ '^[0-9a-f]{64}$'),
      protocol_hash text NOT NULL REFERENCES protocol_locks(protocol_hash) ON DELETE RESTRICT,
      snapshot_id text NOT NULL UNIQUE REFERENCES snapshot_references(snapshot_id) ON DELETE RESTRICT,
      source_revision text NOT NULL CHECK (source_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
      image_repository text NOT NULL CHECK (length(image_repository) > 0),
      image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CHECK (payload ->> 'lockId' = lock_id),
      CHECK (payload ->> 'schemaVersion' = schema_version),
      CHECK (payload ->> 'candidateRunId' = candidate_run_id),
      CHECK (payload ->> 'protocolHash' = protocol_hash),
      CHECK (payload ->> 'sourceRevision' = source_revision),
      CHECK (payload #>> '{image,repository}' = image_repository),
      CHECK (payload #>> '{image,digest}' = image_digest),
      CHECK (payload #>> '{data,snapshotId}' = snapshot_id)
    )
  `

  yield* sql`
    CREATE TABLE qualification_results (
      lock_id text PRIMARY KEY REFERENCES qualification_locks(lock_id) ON DELETE RESTRICT,
      schema_version text NOT NULL CHECK (schema_version = 'bayn.qualification-result.v2'),
      run_id text NOT NULL UNIQUE REFERENCES evaluation_runs(run_id) ON DELETE RESTRICT,
      verdict text NOT NULL CHECK (verdict IN ('QUALIFIED', 'REJECTED')),
      committed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      analysis_hash text NOT NULL CHECK (analysis_hash ~ '^[0-9a-f]{64}$'),
      result_hash text NOT NULL UNIQUE CHECK (result_hash ~ '^[0-9a-f]{64}$'),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      CHECK (
        payload ->> 'schemaVersion' = schema_version
        AND payload ->> 'lockId' = lock_id
        AND payload ->> 'runId' = run_id
        AND payload ->> 'verdict' = verdict
        AND payload #>> '{analysis,analysisHash}' = analysis_hash
        AND payload ->> 'resultHash' = result_hash
      )
    )
  `

  yield* sql`
    CREATE FUNCTION reject_evidence_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
    END
    $function$
  `

  yield* sql`
    CREATE FUNCTION reject_qualification_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
    END
    $function$
  `

  yield* sql`
    CREATE FUNCTION allow_evaluation_completion_only()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'UPDATE'
        AND OLD.status = 'WRITING'
        AND NEW.status = 'COMPLETE'
        AND OLD.completed_at IS NULL
        AND NEW.completed_at IS NOT NULL
        AND (to_jsonb(OLD) - ARRAY['status', 'completed_at']) =
            (to_jsonb(NEW) - ARRAY['status', 'completed_at'])
      THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION '% is immutable except for WRITING to COMPLETE', TG_TABLE_NAME USING ERRCODE = '55000';
    END
    $function$
  `

  yield* sql`
    CREATE FUNCTION burn_completed_evaluation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      reasons text[] := ARRAY['PRE_LOCK_RESULT_OBSERVED'];
    BEGIN
      IF EXISTS (
        SELECT 1 FROM qualification_locks WHERE candidate_run_id = NEW.run_id
      ) THEN
        RETURN NEW;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM gate_outcomes
        WHERE run_id = NEW.run_id
          AND gate_name = 'benchmark_sharpe_improvement'
          AND passed = false
      ) THEN
        reasons := array_append(reasons, 'FAILED_BENCHMARK_GATE');
      END IF;

      INSERT INTO qualification_trials (
        run_id,
        schema_version,
        disposition,
        reason_codes,
        observed_at
      ) VALUES (
        NEW.run_id,
        'bayn.qualification-trial.v1',
        'BURNED',
        reasons,
        COALESCE(NEW.completed_at, transaction_timestamp())
      )
      ON CONFLICT (run_id) DO NOTHING;

      RETURN NEW;
    END
    $function$
  `

  for (const table of appendOnlyEvidenceTables) {
    yield* sql`
      CREATE TRIGGER ${sql(`${table}_append_only`)}
      BEFORE UPDATE OR DELETE ON ${sql(table)}
      FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
    `
    yield* sql`
      CREATE TRIGGER ${sql(`${table}_reject_truncate`)}
      BEFORE TRUNCATE ON ${sql(table)}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
    `
  }

  yield* sql`
    CREATE TRIGGER evaluation_runs_completion_only
    BEFORE UPDATE OR DELETE ON evaluation_runs
    FOR EACH ROW EXECUTE FUNCTION allow_evaluation_completion_only()
  `
  yield* sql`
    CREATE TRIGGER evaluation_runs_reject_truncate
    BEFORE TRUNCATE ON evaluation_runs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER burn_completed_evaluation
    AFTER UPDATE OF status ON evaluation_runs
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'COMPLETE')
    EXECUTE FUNCTION burn_completed_evaluation()
  `

  for (const table of appendOnlyQualificationTables) {
    yield* sql`
      CREATE TRIGGER ${sql(`${table}_append_only`)}
      BEFORE UPDATE OR DELETE ON ${sql(table)}
      FOR EACH ROW EXECUTE FUNCTION reject_qualification_mutation()
    `
    yield* sql`
      CREATE TRIGGER ${sql(`${table}_reject_truncate`)}
      BEFORE TRUNCATE ON ${sql(table)}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_qualification_mutation()
    `
  }
})
