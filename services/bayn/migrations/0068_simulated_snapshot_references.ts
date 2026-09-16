import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE simulated_snapshot_references (
      snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.simulated-snapshot-reference.v1'),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      observed_at timestamptz NOT NULL,
      manifest jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CHECK (manifest ->> 'schemaVersion' IS NOT DISTINCT FROM 'bayn.simulated-market-snapshot.v1'),
      CHECK (manifest ->> 'snapshotId' IS NOT DISTINCT FROM snapshot_id),
      CHECK (manifest ->> 'contentHash' IS NOT DISTINCT FROM content_hash),
      CHECK ((manifest ->> 'observedAt')::timestamptz IS NOT DISTINCT FROM observed_at),
      CHECK (((manifest -> 'streaming' ->> 'runId') ~ '^[0-9a-f]{64}$') IS TRUE),
      CHECK (((manifest -> 'streaming' ->> 'sourceManifestHash') ~ '^[0-9a-f]{64}$') IS TRUE),
      CHECK (manifest -> 'streaming' ->> 'schemaVersion' IS NOT DISTINCT FROM 'bayn.simulated-input-cut.v1')
    )
  `
  yield* sql`
    CREATE TRIGGER simulated_snapshot_references_append_only
    BEFORE UPDATE OR DELETE ON simulated_snapshot_references
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER simulated_snapshot_references_no_truncate
    BEFORE TRUNCATE ON simulated_snapshot_references
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
})
