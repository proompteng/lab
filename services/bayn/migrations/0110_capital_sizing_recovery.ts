import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    DO $migration$
    DECLARE
      definition text := pg_get_functiondef('research_paper_rearm_eligible(text,bigint,timestamptz)'::regprocedure);
      old_guard constant text := $guard$state.kill_state = 'ACTIVE'
              AND (
                state.reason LIKE 'execution cycle loop restricted effective authority:%'
                OR state.reason LIKE 'PAPER autonomous cycle loop restricted effective authority:%'
                OR state.reason = 'reconciliation pass incomplete'$guard$;
      new_guard constant text := $guard$state.kill_state = 'ACTIVE'
              AND (
                state.reason LIKE 'execution cycle loop restricted effective authority:%'
                OR state.reason LIKE 'PAPER autonomous cycle loop restricted effective authority:%'
                OR state.reason = 'reconciliation pass incomplete'
                OR state.reason = 'BLOCKED_CAPITAL_SIZING_CUTOVER'$guard$;
    BEGIN
      IF (length(definition) - length(replace(definition, old_guard, ''))) <> length(old_guard) THEN
        RAISE EXCEPTION 'expected exactly one reconciliation restriction rearm guard' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(definition, old_guard, new_guard);
    END
    $migration$
  `
})
