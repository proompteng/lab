import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Keep the existing identity, terminal-order, fresh-reconciliation, and flat-account proof intact.
  yield* sql`
    DO $migration$
    DECLARE
      function_definition text := pg_get_functiondef(
        'research_paper_rearm_eligible(text,bigint,timestamptz)'::regprocedure
      );
      anchor constant text := 'OR state.reason = ''reconciliation pass incomplete''';
      discrepancy_guard constant text := 'OR state.reason ~ ''^reconciliation discrepancy [0-9a-f]{64}$''';
    BEGIN
      IF strpos(function_definition, discrepancy_guard) > 0 THEN
        RAISE EXCEPTION 'research discrepancy rotation guard already exists' USING ERRCODE = '55000';
      END IF;
      IF (
        length(function_definition) - length(replace(function_definition, anchor, ''))
      ) <> length(anchor) THEN
        RAISE EXCEPTION 'expected exactly one research reconciliation rearm anchor' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(function_definition, anchor, anchor || E'\n                ' || discrepancy_guard);
    END
    $migration$
  `
})
