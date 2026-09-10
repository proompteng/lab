import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Migration 21 owns the lifecycle trigger. Patch its one legacy authority-only guard in place so upgraded
  // databases retain every other transition invariant byte-for-byte.
  yield* sql`
    DO $migration$
    DECLARE
      lifecycle_definition text := pg_get_functiondef('enforce_autonomous_cycle_lifecycle()'::regprocedure);
      legacy_guard constant text := 'AND NOT (paper.risk_block_reason_codes ? ''AUTHORITY_NOT_PAPER'')';
      neutral_guard constant text := 'AND NOT (paper.risk_block_reason_codes ? ''AUTHORITY_NOT_GRANTED'')';
    BEGIN
      IF strpos(lifecycle_definition, neutral_guard) > 0 THEN
        RAISE EXCEPTION 'account-neutral authority terminalization guard already exists' USING ERRCODE = '55000';
      END IF;

      IF (
        length(lifecycle_definition) - length(replace(lifecycle_definition, legacy_guard, ''))
      ) <> length(legacy_guard) THEN
        RAISE EXCEPTION 'expected exactly one legacy authority terminalization guard' USING ERRCODE = '55000';
      END IF;

      lifecycle_definition := replace(
        lifecycle_definition,
        legacy_guard,
        legacy_guard || E'\n                    ' || neutral_guard
      );
      EXECUTE lifecycle_definition;
    END
    $migration$
  `
})
