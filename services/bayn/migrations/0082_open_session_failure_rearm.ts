import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Settlement already preserves an untouched same-plan cycle until its submission cutoff.
  // The rearm predicate must accept that same interval when the market is open.
  yield* sql`
    DO $migration$
    DECLARE
      function_definition text := pg_get_functiondef(
        'research_paper_rearm_eligible(text,bigint,timestamptz)'::regprocedure
      );
      old_guard constant text := $guard$AND previous_generation.strategy_protocol_hash = cycle.strategy_protocol_hash
                  AND cycle.schema_version IN ('bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
                  AND cycle.identity_schema_version IN ('bayn.autonomous-cycle-identity.v3', 'bayn.autonomous-cycle-identity.v4')
                  AND cycle.snapshot_id IS NULL
                  AND cycle.decision_hash IS NULL
                  AND cycle.updated_at <= candidate_activated_at
                  AND candidate_activated_at < cycle.submission_open_at$guard$;
      new_guard constant text := $guard$AND previous_generation.strategy_protocol_hash = cycle.strategy_protocol_hash
                  AND cycle.schema_version IN ('bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
                  AND cycle.identity_schema_version IN ('bayn.autonomous-cycle-identity.v3', 'bayn.autonomous-cycle-identity.v4')
                  AND cycle.snapshot_id IS NULL
                  AND cycle.decision_hash IS NULL
                  AND cycle.updated_at <= candidate_activated_at
                  AND candidate_activated_at < cycle.submission_cutoff_at$guard$;
    BEGIN
      IF (length(function_definition) - length(replace(function_definition, old_guard, ''))) <> length(old_guard) THEN
        RAISE EXCEPTION 'expected exactly one execution failure rearm guard' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(function_definition, old_guard, new_guard);
    END
    $migration$
  `
})
