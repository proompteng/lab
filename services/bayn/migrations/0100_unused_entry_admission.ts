import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE autonomous_cycles DROP CONSTRAINT autonomous_cycles_terminal_reason_check,
    ADD CONSTRAINT autonomous_cycles_terminal_reason_check CHECK (terminal_reason IN (
      'BLOCKED_MISSED_PUBLICATION_DEADLINE','BLOCKED_MISSED_SUBMISSION_DEADLINE','BLOCKED_UNUSED_ENTRY_EXPIRED',
      'BLOCKED_DATA_UNAVAILABLE','BLOCKED_DATA_STALE','BLOCKED_DATA_INVALID','BLOCKED_PROVENANCE_MISMATCH',
      'BLOCKED_AUTHORITY','BLOCKED_KILL_ACTIVE','BLOCKED_BROKER_DISABLED','BLOCKED_BROKER_UNAVAILABLE',
      'BLOCKED_UNRESOLVED_MUTATION','BLOCKED_RECONCILIATION','BLOCKED_RISK'
    ))`
  yield* sql`CREATE FUNCTION enforce_unused_entry_admission() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE deadline timestamptz;
    BEGIN
      IF OLD.schema_version = 'bayn.autonomous-cycle.v4'
        AND OLD.decision_hash IS NULL AND NEW.decision_hash IS NOT NULL THEN
        deadline := LEAST(OLD.submission_cutoff_at,
          GREATEST(OLD.created_at,OLD.submission_open_at) + interval '1 minute');
        IF GREATEST(NEW.updated_at,execution_account_now(NEW.account_id)) >= deadline THEN
          RAISE EXCEPTION 'entry decision binding exceeded its admission lease'
            USING ERRCODE = '23514', CONSTRAINT = 'autonomous_cycles_entry_admission_deadline';
        END IF;
      END IF;
      IF NEW.terminal_reason = 'BLOCKED_UNUSED_ENTRY_EXPIRED' AND (
        OLD.schema_version <> 'bayn.autonomous-cycle.v4' OR OLD.state NOT IN ('PENDING','ACTIVE')
        OR OLD.snapshot_id IS NOT NULL OR OLD.decision_hash IS NOT NULL
        OR NEW.snapshot_id IS NOT NULL OR NEW.decision_hash IS NOT NULL
        OR NEW.updated_at < LEAST(OLD.submission_cutoff_at,
          GREATEST(OLD.created_at,OLD.submission_open_at) + interval '1 minute')
        OR EXISTS (SELECT 1 FROM intents WHERE cycle_id = OLD.cycle_id)
      ) THEN
        RAISE EXCEPTION 'unused entry admission must expire without bound evidence or intents' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$`
  yield* sql`CREATE TRIGGER autonomous_cycles_unused_entry_admission
    BEFORE UPDATE ON autonomous_cycles FOR EACH ROW EXECUTE FUNCTION enforce_unused_entry_admission()`
  yield* sql`CREATE CONSTRAINT TRIGGER autonomous_cycles_entry_admission_commit
    AFTER UPDATE ON autonomous_cycles DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (OLD.decision_hash IS NULL AND NEW.decision_hash IS NOT NULL)
    EXECUTE FUNCTION enforce_unused_entry_admission()`
})
