import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE bayn_qualification_locks
      DROP CONSTRAINT bayn_qualification_locks_schema_version_check,
      ADD COLUMN candidate_run_id text NOT NULL UNIQUE CHECK (candidate_run_id ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT bayn_qualification_locks_schema_version_check
        CHECK (schema_version = 'bayn.qualification-lock.v2'),
      ADD CONSTRAINT bayn_qualification_locks_snapshot_id_key UNIQUE (snapshot_id),
      ADD CONSTRAINT bayn_qualification_locks_candidate_payload_check
        CHECK (payload ->> 'candidateRunId' = candidate_run_id)
  `

  yield* sql`
    ALTER TABLE bayn_qualification_results
      DROP CONSTRAINT bayn_qualification_results_schema_version_check,
      ADD COLUMN analysis_hash text NOT NULL CHECK (analysis_hash ~ '^[0-9a-f]{64}$'),
      ADD COLUMN result_hash text NOT NULL UNIQUE CHECK (result_hash ~ '^[0-9a-f]{64}$'),
      ADD COLUMN payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      ADD CONSTRAINT bayn_qualification_results_schema_version_check
        CHECK (schema_version = 'bayn.qualification-result.v2'),
      ADD CONSTRAINT bayn_qualification_results_payload_binding_check CHECK (
        payload ->> 'schemaVersion' = schema_version
        AND payload ->> 'lockId' = lock_id
        AND payload ->> 'runId' = run_id
        AND payload ->> 'verdict' = verdict
        AND payload #>> '{analysis,analysisHash}' = analysis_hash
        AND payload ->> 'resultHash' = result_hash
      )
  `

  yield* sql`
    CREATE OR REPLACE FUNCTION bayn_burn_completed_evaluation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      reasons text[] := ARRAY['PRE_LOCK_RESULT_OBSERVED'];
    BEGIN
      IF EXISTS (
        SELECT 1 FROM bayn_qualification_locks WHERE candidate_run_id = NEW.run_id
      ) THEN
        RETURN NEW;
      END IF;

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
    CREATE TRIGGER bayn_evaluation_runs_reject_truncate
    BEFORE TRUNCATE ON bayn_evaluation_runs
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_protocol_locks_reject_truncate
    BEFORE TRUNCATE ON bayn_protocol_locks
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_snapshot_references_reject_truncate
    BEFORE TRUNCATE ON bayn_snapshot_references
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_evaluation_artifacts_reject_truncate
    BEFORE TRUNCATE ON bayn_evaluation_artifacts
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_evaluation_events_reject_truncate
    BEFORE TRUNCATE ON bayn_evaluation_events
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_gate_outcomes_reject_truncate
    BEFORE TRUNCATE ON bayn_gate_outcomes
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_status_history_reject_truncate
    BEFORE TRUNCATE ON bayn_status_history
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_qualification_trials_reject_truncate
    BEFORE TRUNCATE ON bayn_qualification_trials
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_qualification_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_qualification_locks_reject_truncate
    BEFORE TRUNCATE ON bayn_qualification_locks
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_qualification_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_qualification_results_reject_truncate
    BEFORE TRUNCATE ON bayn_qualification_results
    FOR EACH STATEMENT EXECUTE FUNCTION bayn_reject_qualification_mutation()
  `
})
