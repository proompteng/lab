import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE simulated_broker_checkpoints (
    ordinal bigserial PRIMARY KEY,
    account_id text NOT NULL REFERENCES simulated_execution_clocks(account_id),
    source_manifest_hash text NOT NULL CHECK(source_manifest_hash ~ '^[0-9a-f]{64}$'),
    checkpoint_hash text NOT NULL CHECK(checkpoint_hash ~ '^[0-9a-f]{64}$'),
    observed_at timestamptz NOT NULL,
    payload jsonb NOT NULL CHECK(jsonb_typeof(payload) = 'object'),
    UNIQUE(account_id, checkpoint_hash)
  )`
  yield* sql`CREATE FUNCTION enforce_simulated_broker_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.payload->>'checkpointHash' IS DISTINCT FROM NEW.checkpoint_hash
        OR NEW.payload->>'sourceManifestHash' IS DISTINCT FROM NEW.source_manifest_hash
        OR NEW.payload#>>'{state,accountId}' IS DISTINCT FROM NEW.account_id
        OR (NEW.payload->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at THEN
        RAISE EXCEPTION 'broker checkpoint payload must match its receipt' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS(SELECT 1 FROM simulated_execution_clocks
        WHERE account_id = NEW.account_id AND source_manifest_hash = NEW.source_manifest_hash
          AND observed_at <= NEW.observed_at) THEN
        RAISE EXCEPTION 'broker checkpoint must match its source and cannot precede the committed execution clock' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$`
  yield* sql`CREATE TRIGGER simulated_broker_checkpoint_identity BEFORE INSERT ON simulated_broker_checkpoints
    FOR EACH ROW EXECUTE FUNCTION enforce_simulated_broker_checkpoint()`
  yield* sql`CREATE TRIGGER simulated_broker_checkpoint_immutable BEFORE UPDATE OR DELETE ON simulated_broker_checkpoints
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER simulated_broker_checkpoint_no_truncate BEFORE TRUNCATE ON simulated_broker_checkpoints
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
