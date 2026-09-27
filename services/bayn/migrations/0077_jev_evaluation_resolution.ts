import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE jev_evaluation_receipts ADD CONSTRAINT jev_receipt_request_hash UNIQUE (request_id, receipt_hash)`
  yield* sql`
    CREATE TABLE jev_evaluation_resolutions (
      request_id text PRIMARY KEY REFERENCES jev_evaluation_requests (request_id),
      resolution_hash text NOT NULL UNIQUE CHECK (resolution_hash ~ '^[0-9a-f]{64}$'),
      receipt_hash text GENERATED ALWAYS AS (payload->>'receiptHash') STORED,
      payload jsonb NOT NULL CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-resolution.v1'
        AND payload->>'requestId' IS NOT DISTINCT FROM request_id
        AND payload->>'resolutionHash' IS NOT DISTINCT FROM resolution_hash
        AND ((payload->>'status' IS NOT DISTINCT FROM 'RECORDED' AND payload->>'receiptHash' IS NOT NULL)
          OR (payload->>'status' IS NOT DISTINCT FROM 'ABANDONED' AND payload->>'receiptHash' IS NULL AND payload->>'abandonedAt' IS NOT NULL))
      ),
      FOREIGN KEY (request_id, receipt_hash) REFERENCES jev_evaluation_receipts (request_id, receipt_hash)
    )
  `
  yield* sql`
    INSERT INTO jev_evaluation_resolutions (request_id, resolution_hash, payload)
    SELECT request_id, hash, material::jsonb || jsonb_build_object('resolutionHash', hash)
    FROM (
      SELECT request_id, material, encode(sha256(convert_to(material, 'UTF8')), 'hex') AS hash
      FROM (
        SELECT request_id, format(
          '{"receiptHash":"%s","requestId":"%s","schemaVersion":"bayn.jev-evaluation-resolution.v1","status":"RECORDED"}',
          receipt_hash, request_id
        ) AS material FROM jev_evaluation_receipts
      ) AS canonical
    ) AS hashed
  `
  yield* sql`CREATE TRIGGER jev_evaluation_resolutions_immutable
    BEFORE UPDATE OR DELETE ON jev_evaluation_resolutions
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER jev_evaluation_resolutions_reject_truncate
    BEFORE TRUNCATE ON jev_evaluation_resolutions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
