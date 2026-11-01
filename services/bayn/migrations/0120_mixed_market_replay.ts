import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Historical simulation evidence is immutable. New inserts use only the current mixed-source contract.
  yield* sql`DO $migration$
    DECLARE retired text; constraint_name name; matches integer;
    BEGIN
      FOREACH retired IN ARRAY ARRAY[
        'bayn.simulated-snapshot-reference.v1',
        'bayn.simulated-market-snapshot.v1',
        'bayn.simulated-input-cut.v1'
      ] LOOP
        SELECT count(*),min(conname) INTO matches,constraint_name
        FROM pg_constraint WHERE conrelid='simulated_snapshot_references'::regclass
          AND contype='c' AND strpos(pg_get_constraintdef(oid),retired)>0;
        IF matches <> 1 THEN RAISE EXCEPTION 'expected one retired simulation constraint for %',retired; END IF;
        EXECUTE format('ALTER TABLE simulated_snapshot_references DROP CONSTRAINT %I',constraint_name);
      END LOOP;
    END $migration$`
  yield* sql`ALTER TABLE simulated_snapshot_references ADD CONSTRAINT simulated_snapshot_current_source
    CHECK (schema_version='bayn.simulated-snapshot-reference.v2'
      AND manifest->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.simulated-market-snapshot.v2'
      AND manifest->'streaming'->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.simulated-input-cut.v2'
      AND jsonb_typeof(manifest->'streaming'->'marketSources') IS NOT DISTINCT FROM 'array'
      AND jsonb_array_length(manifest->'streaming'->'marketSources')>0) NOT VALID`
})
