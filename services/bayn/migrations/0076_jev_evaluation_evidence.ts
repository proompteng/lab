import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE jev_evaluation_requests (
      request_id text PRIMARY KEY CHECK (request_id ~ '^[0-9a-f]{64}$'),
      cycle_id text NOT NULL REFERENCES autonomous_cycles (cycle_id),
      authority_generation_hash text NOT NULL REFERENCES authority_generations (generation_hash),
      snapshot_id text GENERATED ALWAYS AS (payload->>'snapshotId') STORED NOT NULL
        CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
      symbol text GENERATED ALWAYS AS (payload->>'symbol') STORED NOT NULL,
      payload jsonb NOT NULL CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-request.v1'
        AND payload->>'requestId' IS NOT DISTINCT FROM request_id
        AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
        AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
      ),
      UNIQUE (cycle_id, authority_generation_hash, snapshot_id, symbol)
    )
  `
  yield* sql`CREATE INDEX jev_evaluation_requests_cycle ON jev_evaluation_requests (cycle_id)`
  yield* sql`
    CREATE TABLE jev_evaluation_receipts (
      request_id text PRIMARY KEY REFERENCES jev_evaluation_requests (request_id),
      receipt_hash text NOT NULL UNIQUE CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
      payload jsonb NOT NULL CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-receipt.v1'
        AND payload->>'requestId' IS NOT DISTINCT FROM request_id
        AND payload->>'receiptHash' IS NOT DISTINCT FROM receipt_hash
      )
    )
  `
  yield* sql`CREATE TRIGGER jev_evaluation_requests_immutable
    BEFORE UPDATE OR DELETE ON jev_evaluation_requests
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER jev_evaluation_requests_reject_truncate
    BEFORE TRUNCATE ON jev_evaluation_requests
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER jev_evaluation_receipts_immutable
    BEFORE UPDATE OR DELETE ON jev_evaluation_receipts
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER jev_evaluation_receipts_reject_truncate
    BEFORE TRUNCATE ON jev_evaluation_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
