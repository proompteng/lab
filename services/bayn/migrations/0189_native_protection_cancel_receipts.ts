import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE native_protection_cancel_receipts (
    intent_id text NOT NULL,
    account_id text NOT NULL,
    broker_order_id text NOT NULL,
    requested_at timestamptz NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    request_id text NOT NULL CHECK (length(request_id) > 0 AND request_id = btrim(request_id)),
    response_status smallint NOT NULL CHECK (response_status = 204),
    response_content_hash text NOT NULL CHECK (response_content_hash ~ '^[0-9a-f]{64}$'),
    routing jsonb,
    observed_at timestamptz NOT NULL,
    PRIMARY KEY (intent_id, broker_order_id, requested_at),
    FOREIGN KEY (intent_id, account_id) REFERENCES intents(intent_id, account_id) ON DELETE RESTRICT,
    FOREIGN KEY (intent_id, broker_order_id, requested_at)
      REFERENCES native_protection_cancel_commands(intent_id, broker_order_id, requested_at) ON DELETE RESTRICT,
    CHECK (observed_at >= requested_at),
    CHECK (routing IS NULL OR jsonb_typeof(routing) = 'object')
  )`
  yield* sql`CREATE TRIGGER native_protection_cancel_receipts_append_only
    BEFORE UPDATE OR DELETE ON native_protection_cancel_receipts
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER native_protection_cancel_receipts_no_truncate
    BEFORE TRUNCATE ON native_protection_cancel_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
