import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE broker_notification_receipts (
    account_id text NOT NULL,
    event_id text NOT NULL CHECK (event_id ~ '^[a-f0-9]{64}$'),
    source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
    received_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(account_id,event_id)
  )`
  yield* sql`CREATE INDEX broker_notification_receipts_watermark ON broker_notification_receipts(account_id,recorded_at DESC)`
  // Keep database precision for notification fencing; financial snapshot timestamps retain their original codec.
  yield* sql`ALTER TABLE broker_observations ADD COLUMN notification_fence_at timestamptz`
  yield* sql`UPDATE broker_observations SET notification_fence_at = poll_started_at`
  yield* sql`CREATE TRIGGER broker_notification_receipts_immutable BEFORE UPDATE OR DELETE ON broker_notification_receipts
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_notification_receipts_no_truncate BEFORE TRUNCATE ON broker_notification_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
