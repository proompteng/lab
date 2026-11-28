import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE protection_release_read_claims (
    claim_id text PRIMARY KEY,
    intent_id text NOT NULL,
    broker_order_id text NOT NULL,
    requested_at timestamptz NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (intent_id, broker_order_id, requested_at),
    FOREIGN KEY (intent_id, broker_order_id, requested_at)
      REFERENCES native_protection_cancel_receipts(intent_id, broker_order_id, requested_at) ON DELETE RESTRICT
  )`
  yield* sql`CREATE TRIGGER protection_release_read_claims_append_only
    BEFORE UPDATE OR DELETE ON protection_release_read_claims
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER protection_release_read_claims_no_truncate
    BEFORE TRUNCATE ON protection_release_read_claims
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`ALTER TABLE broker_observations
    ADD COLUMN protection_read_expires_at timestamptz,
    ADD COLUMN protection_read_cost_ms integer CHECK (protection_read_cost_ms > 0),
    ADD COLUMN protection_read_claim_id text REFERENCES protection_release_read_claims(claim_id),
    ADD CONSTRAINT broker_observation_protection_credit_pair CHECK (
      (protection_read_expires_at IS NULL) = (protection_read_cost_ms IS NULL)
    )`
  yield* sql`ALTER TABLE protection_release_proofs
    ADD COLUMN read_claim_id text NOT NULL UNIQUE REFERENCES protection_release_read_claims(claim_id) ON DELETE RESTRICT`
})
