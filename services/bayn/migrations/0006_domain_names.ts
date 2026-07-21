import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

const tables = [
  ['bayn_protocol_locks', 'protocol_locks'],
  ['bayn_snapshot_references', 'snapshot_references'],
  ['bayn_evaluation_runs', 'evaluation_runs'],
  ['bayn_evaluation_artifacts', 'evaluation_artifacts'],
  ['bayn_evaluation_events', 'evaluation_events'],
  ['bayn_gate_outcomes', 'gate_outcomes'],
  ['bayn_status_history', 'status_history'],
  ['bayn_qualification_trials', 'qualification_trials'],
  ['bayn_qualification_locks', 'qualification_locks'],
  ['bayn_qualification_results', 'qualification_results'],
] as const

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  for (const [legacyName, domainName] of tables) {
    yield* sql`ALTER TABLE ${sql(legacyName)} RENAME TO ${sql(domainName)}`
  }

  yield* sql`
    DO $block$
    DECLARE
      item record;
    BEGIN
      FOR item IN
        SELECT constraint_row.conrelid, constraint_row.conname
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.connamespace = 'public'::regnamespace
          AND constraint_row.conrelid <> 0
          AND constraint_row.conname LIKE 'bayn\_%' ESCAPE '\'
        ORDER BY constraint_row.conrelid, constraint_row.conname
      LOOP
        EXECUTE format(
          'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
          item.conrelid::regclass,
          item.conname,
          substring(item.conname FROM 6)
        );
      END LOOP;
    END
    $block$
  `

  yield* sql`
    ALTER INDEX bayn_status_history_run_sequence_idx
      RENAME TO status_history_run_sequence_idx
  `

  yield* sql`ALTER FUNCTION bayn_reject_evidence_mutation() RENAME TO reject_evidence_mutation`
  yield* sql`ALTER FUNCTION bayn_reject_qualification_mutation() RENAME TO reject_qualification_mutation`
  yield* sql`ALTER FUNCTION bayn_allow_evaluation_completion_only() RENAME TO allow_evaluation_completion_only`
  yield* sql`ALTER FUNCTION bayn_burn_completed_evaluation() RENAME TO burn_completed_evaluation`

  yield* sql`
    CREATE OR REPLACE FUNCTION burn_completed_evaluation()
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

  yield* sql`
    DO $block$
    DECLARE
      item record;
    BEGIN
      FOR item IN
        SELECT trigger_row.tgrelid, trigger_row.tgname
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE NOT trigger_row.tgisinternal
          AND trigger_row.tgname LIKE 'bayn\_%' ESCAPE '\'
        ORDER BY trigger_row.tgrelid, trigger_row.tgname
      LOOP
        EXECUTE format(
          'ALTER TRIGGER %I ON %s RENAME TO %I',
          item.tgname,
          item.tgrelid::regclass,
          substring(item.tgname FROM 6)
        );
      END LOOP;
    END
    $block$
  `
})
