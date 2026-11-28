import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE protection_release_proofs (
    proof_id text PRIMARY KEY CHECK (proof_id ~ '^[0-9a-f]{64}$'),
    intent_id text NOT NULL,
    broker_order_id text NOT NULL,
    requested_at timestamptz NOT NULL,
    evidence jsonb NOT NULL CHECK (
      evidence->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.protection-release-proof.v1'
      AND evidence #>> '{readback,command,intentId}' IS NOT DISTINCT FROM intent_id
      AND evidence #>> '{readback,command,brokerOrderId}' IS NOT DISTINCT FROM broker_order_id
    ),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (intent_id, broker_order_id, requested_at)
      REFERENCES native_protection_cancel_receipts(intent_id, broker_order_id, requested_at) ON DELETE RESTRICT
  )`
  yield* sql`CREATE TRIGGER protection_release_proofs_append_only BEFORE UPDATE OR DELETE ON protection_release_proofs
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER protection_release_proofs_no_truncate BEFORE TRUNCATE ON protection_release_proofs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
