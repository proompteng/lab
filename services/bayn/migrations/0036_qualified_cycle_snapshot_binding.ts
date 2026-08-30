import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`LOCK TABLE autonomous_cycles IN SHARE ROW EXCLUSIVE MODE`

      yield* sql`
        DO $function$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM autonomous_cycles AS cycle
            WHERE cycle.snapshot_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM qualification_results AS result
                WHERE result.run_id = cycle.qualification_run_id
                  AND (
                    result.verdict = 'QUALIFIED'
                    OR cycle.state IN ('PENDING', 'ACTIVE')
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM qualification_results AS result
                JOIN qualification_locks AS lock
                  ON lock.lock_id = result.lock_id
                  AND lock.candidate_run_id = result.run_id
                WHERE result.run_id = cycle.qualification_run_id
                  AND result.verdict = 'QUALIFIED'
                  AND lock.snapshot_id = cycle.snapshot_id
              )
          ) THEN
            RAISE EXCEPTION 'qualified cycle snapshot binding migration found incompatible history'
              USING ERRCODE = '23514';
          END IF;
        END
        $function$
      `

      yield* sql`
        CREATE FUNCTION enforce_qualified_cycle_snapshot_binding()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF NEW.snapshot_id IS NULL THEN
            RETURN NEW;
          END IF;

          IF TG_OP = 'UPDATE' AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id THEN
            RETURN NEW;
          END IF;

          IF EXISTS (
            SELECT 1
            FROM qualification_results AS result
            WHERE result.run_id = NEW.qualification_run_id
          ) AND NOT EXISTS (
            SELECT 1
            FROM qualification_results AS result
            JOIN qualification_locks AS lock
              ON lock.lock_id = result.lock_id
              AND lock.candidate_run_id = result.run_id
            WHERE result.run_id = NEW.qualification_run_id
              AND result.verdict = 'QUALIFIED'
              AND lock.snapshot_id = NEW.snapshot_id
          ) THEN
            RAISE EXCEPTION 'autonomous cycle snapshot does not match its terminal qualified dataset'
              USING ERRCODE = '23514';
          END IF;

          RETURN NEW;
        END
        $function$
      `

      yield* sql`
        CREATE TRIGGER autonomous_cycle_qualified_snapshot_binding
        BEFORE INSERT OR UPDATE ON autonomous_cycles
        FOR EACH ROW EXECUTE FUNCTION enforce_qualified_cycle_snapshot_binding()
      `
    }),
  )
})
