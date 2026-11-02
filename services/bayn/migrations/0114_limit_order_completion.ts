import { SqlClient } from 'effect/sql'
import { Effect } from 'effect'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`ALTER FUNCTION paper_partial_ioc_entry_is_reconciled_flat(text,text,numeric,timestamptz)
    RENAME TO paper_partial_limit_entry_is_reconciled_flat`
  yield* sql`DO $completion$
    DECLARE
      definition text := pg_get_functiondef('paper_cycle_completion_evidence_matches(text,text,timestamptz)'::regprocedure);
      old_terms constant text := $terms$intent.time_in_force = 'IOC'$terms$;
      new_terms constant text := $terms$intent.time_in_force IN ('DAY', 'IOC')$terms$;
      old_helper constant text := 'paper_partial_ioc_entry_is_reconciled_flat';
      new_helper constant text := 'paper_partial_limit_entry_is_reconciled_flat';
    BEGIN
      IF (length(definition) - length(replace(definition, old_terms, ''))) <> length(old_terms)
        OR (length(definition) - length(replace(definition, old_helper, ''))) <> length(old_helper) THEN
        RAISE EXCEPTION 'expected one limit completion duration guard and one partial-fill helper' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(replace(definition, old_terms, new_terms), old_helper, new_helper);
    END $completion$`
})
