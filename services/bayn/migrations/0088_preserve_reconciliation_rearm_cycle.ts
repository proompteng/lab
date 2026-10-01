import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    DO $migration$
    DECLARE
      function_definition text := pg_get_functiondef(
        'research_paper_rearm_eligible(text,bigint,timestamptz)'::regprocedure
      );
      anchor constant text := $guard$AND (
                    state.reason LIKE 'execution cycle loop restricted effective authority:%'
                    OR state.reason LIKE 'PAPER autonomous cycle loop restricted effective authority:%'
                  )
                  AND previous_generation.activation_schema_version = 'bayn.paper-authority-generation.v3'$guard$;
      replacement constant text := $guard$AND (
                    state.reason LIKE 'execution cycle loop restricted effective authority:%'
                    OR state.reason LIKE 'PAPER autonomous cycle loop restricted effective authority:%'
                    OR state.reason = 'reconciliation pass incomplete'
                    OR state.reason ~ '^reconciliation discrepancy [0-9a-f]{64}$'
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM autonomous_cycle_shadow_decisions AS cycle_decision
                    WHERE cycle_decision.cycle_id = cycle.cycle_id
                  )
                  AND previous_generation.activation_schema_version = 'bayn.paper-authority-generation.v3'$guard$;
    BEGIN
      IF (
        length(function_definition) - length(replace(function_definition, anchor, ''))
      ) <> length(anchor) THEN
        RAISE EXCEPTION 'expected exactly one untouched failure cycle rearm guard' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(function_definition, anchor, replacement);
    END
    $migration$
  `
})
