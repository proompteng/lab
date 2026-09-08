import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Migration 37 owns the current function body. Add the exact transient reconciliation reason without duplicating
  // the long authority, identity, mutation, flat-account, and fresh-reconciliation proof in another migration.
  yield* sql`
    DO $migration$
    DECLARE
      function_definition text := pg_get_functiondef(
        'research_paper_rearm_eligible(text,bigint,timestamptz)'::regprocedure
      );
      anchor constant text :=
        'OR state.reason LIKE ''PAPER autonomous cycle loop restricted effective authority:%''';
      reconciliation_guard constant text :=
        'OR state.reason = ''reconciliation pass incomplete''';
    BEGIN
      IF strpos(function_definition, reconciliation_guard) > 0 THEN
        RAISE EXCEPTION 'research reconciliation rearm guard already exists' USING ERRCODE = '55000';
      END IF;

      IF (
        length(function_definition) - length(replace(function_definition, anchor, ''))
      ) <> length(anchor) THEN
        RAISE EXCEPTION 'expected exactly one research rearm compatibility anchor' USING ERRCODE = '55000';
      END IF;

      function_definition := replace(
        function_definition,
        anchor,
        anchor || E'\n                ' || reconciliation_guard
      );
      EXECUTE function_definition;
    END
    $migration$
  `
})
