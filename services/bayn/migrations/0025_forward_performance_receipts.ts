import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE autonomous_forward_performance_receipts (
      authority_generation_hash text PRIMARY KEY
        CHECK (authority_generation_hash ~ '^[0-9a-f]{64}$'),
      cycle_id text NOT NULL REFERENCES autonomous_cycles(cycle_id) ON DELETE RESTRICT
        CHECK (cycle_id ~ '^[0-9a-f]{64}$'),
      document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
      created_at timestamptz NOT NULL,
      content_hash text GENERATED ALWAYS AS (document ->> 'contentHash') STORED NOT NULL
        CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      CHECK (document ->> 'schemaVersion' = 'bayn.forward-performance-receipt-envelope.v1'),
      CHECK (document ->> 'authorityGenerationHash' = authority_generation_hash),
      CHECK (document ->> 'cycleId' = cycle_id),
      CHECK ((document ->> 'createdAt')::timestamptz = created_at),
      CHECK ((document -> 'receipt') ->> 'receiptHash' = document ->> 'receiptHash')
    )
  `

  yield* sql`
    CREATE TRIGGER autonomous_forward_performance_receipts_append_only
    BEFORE UPDATE OR DELETE ON autonomous_forward_performance_receipts
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `

  yield* sql`
    CREATE TRIGGER autonomous_forward_performance_receipts_reject_truncate
    BEFORE TRUNCATE ON autonomous_forward_performance_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
})
