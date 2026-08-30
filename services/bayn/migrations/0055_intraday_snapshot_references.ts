import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE intraday_snapshot_references (
      snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.intraday-snapshot-reference.v1'),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      observed_at timestamptz NOT NULL,
      manifest jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      CHECK (manifest ->> 'schemaVersion' = 'bayn.intraday-market-snapshot.v1'),
      CHECK (manifest ->> 'snapshotId' = snapshot_id),
      CHECK (manifest ->> 'contentHash' = content_hash),
      CHECK ((manifest ->> 'observedAt')::timestamptz = observed_at)
    )
  `

  yield* sql`
    CREATE TRIGGER intraday_snapshot_references_append_only
    BEFORE UPDATE OR DELETE ON intraday_snapshot_references
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `
})
