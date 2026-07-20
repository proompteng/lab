import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE bayn_qualification_trials (
      run_id text PRIMARY KEY REFERENCES bayn_evaluation_runs(run_id) ON DELETE RESTRICT,
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
    CREATE TABLE bayn_qualification_locks (
      lock_id text PRIMARY KEY CHECK (lock_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.qualification-lock.v1'),
      protocol_hash text NOT NULL REFERENCES bayn_protocol_locks(protocol_hash) ON DELETE RESTRICT,
      snapshot_id text NOT NULL REFERENCES bayn_snapshot_references(snapshot_id) ON DELETE RESTRICT,
      source_revision text NOT NULL CHECK (source_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
      image_repository text NOT NULL CHECK (length(image_repository) > 0),
      image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CHECK (payload ->> 'lockId' = lock_id),
      CHECK (payload ->> 'schemaVersion' = schema_version),
      CHECK (payload ->> 'protocolHash' = protocol_hash),
      CHECK (payload ->> 'sourceRevision' = source_revision),
      CHECK (payload #>> '{image,repository}' = image_repository),
      CHECK (payload #>> '{image,digest}' = image_digest),
      CHECK (payload #>> '{data,snapshotId}' = snapshot_id)
    )
  `

  yield* sql`
    CREATE FUNCTION bayn_reject_qualification_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
    END
    $function$
  `

  yield* sql`
    CREATE TRIGGER bayn_qualification_trials_append_only
    BEFORE UPDATE OR DELETE ON bayn_qualification_trials
    FOR EACH ROW EXECUTE FUNCTION bayn_reject_qualification_mutation()
  `

  yield* sql`
    CREATE TRIGGER bayn_qualification_locks_append_only
    BEFORE UPDATE OR DELETE ON bayn_qualification_locks
    FOR EACH ROW EXECUTE FUNCTION bayn_reject_qualification_mutation()
  `

  yield* sql`
    CREATE FUNCTION bayn_burn_completed_evaluation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      reasons text[] := ARRAY['PRE_LOCK_RESULT_OBSERVED'];
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM bayn_gate_outcomes
        WHERE run_id = NEW.run_id
          AND gate_name = 'benchmark_sharpe_improvement'
          AND passed = false
      ) THEN
        reasons := array_append(reasons, 'FAILED_BENCHMARK_GATE');
      END IF;

      INSERT INTO bayn_qualification_trials (
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

  yield* sql`
    CREATE TRIGGER bayn_burn_completed_evaluation
    AFTER UPDATE OF status ON bayn_evaluation_runs
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'COMPLETE')
    EXECUTE FUNCTION bayn_burn_completed_evaluation()
  `

  yield* sql`
    INSERT INTO bayn_qualification_trials (
      run_id,
      schema_version,
      disposition,
      reason_codes,
      observed_at
    )
    SELECT
      run.run_id,
      'bayn.qualification-trial.v1',
      'BURNED',
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM bayn_gate_outcomes AS gate
          WHERE gate.run_id = run.run_id
            AND gate.gate_name = 'benchmark_sharpe_improvement'
            AND gate.passed = false
        )
          THEN ARRAY['PRE_LOCK_RESULT_OBSERVED', 'FAILED_BENCHMARK_GATE']
        ELSE ARRAY['PRE_LOCK_RESULT_OBSERVED']
      END,
      COALESCE(run.completed_at, run.created_at)
    FROM bayn_evaluation_runs AS run
    WHERE run.status = 'COMPLETE'
    ON CONFLICT (run_id) DO NOTHING
  `
})
