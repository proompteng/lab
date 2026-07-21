import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE FUNCTION bayn_reject_evidence_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
    END
    $function$
  `

  yield* sql`
    CREATE TRIGGER bayn_protocol_locks_append_only
    BEFORE UPDATE OR DELETE ON bayn_protocol_locks
    FOR EACH ROW EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_snapshot_references_append_only
    BEFORE UPDATE OR DELETE ON bayn_snapshot_references
    FOR EACH ROW EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_evaluation_artifacts_append_only
    BEFORE UPDATE OR DELETE ON bayn_evaluation_artifacts
    FOR EACH ROW EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_evaluation_events_append_only
    BEFORE UPDATE OR DELETE ON bayn_evaluation_events
    FOR EACH ROW EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_gate_outcomes_append_only
    BEFORE UPDATE OR DELETE ON bayn_gate_outcomes
    FOR EACH ROW EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER bayn_status_history_append_only
    BEFORE UPDATE OR DELETE ON bayn_status_history
    FOR EACH ROW EXECUTE FUNCTION bayn_reject_evidence_mutation()
  `

  yield* sql`
    CREATE FUNCTION bayn_allow_evaluation_completion_only()
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
    CREATE TRIGGER bayn_evaluation_runs_completion_only
    BEFORE UPDATE OR DELETE ON bayn_evaluation_runs
    FOR EACH ROW EXECUTE FUNCTION bayn_allow_evaluation_completion_only()
  `
})
