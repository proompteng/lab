import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE FUNCTION enforce_jev_exit_commit_deadline() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE
      checked_at timestamptz;
      deadline_at timestamptz;
    BEGIN
      IF NEW.document #>> '{document,strategyDecision,schemaVersion}' = 'bayn.jev-exit-target.v1' THEN
        checked_at := execution_account_now(NEW.document #>> '{document,bindings,accountId}');
        deadline_at := (NEW.document #>> '{document,strategyDecision,commitDeadlineAt}')::timestamptz;
        IF deadline_at IS NULL OR checked_at < NEW.created_at OR checked_at >= deadline_at THEN
          RAISE EXCEPTION 'initial Jev exit evidence expired before transaction commitment' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `
  yield* sql`
    CREATE CONSTRAINT TRIGGER jev_exit_commit_deadline
    AFTER INSERT ON autonomous_cycle_paper_closures
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_jev_exit_commit_deadline()
  `
})
