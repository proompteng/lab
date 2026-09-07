import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE intraday_archive_availability (
      reader_endpoint_hash text NOT NULL CHECK (reader_endpoint_hash ~ '^[0-9a-f]{64}$'),
      record_id text NOT NULL CHECK (record_id ~ '^[0-9a-f]{64}$'),
      record_content_hash text NOT NULL CHECK (record_content_hash ~ '^[0-9a-f]{64}$'),
      verification text NOT NULL CHECK (verification IN ('embedded', 'development-configured')),
      read_started_at timestamptz NOT NULL,
      available_at timestamptz NOT NULL,
      receipt_hash text NOT NULL UNIQUE CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
      receipt jsonb NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (reader_endpoint_hash, record_id, verification),
      CHECK (available_at >= read_started_at),
      CHECK (receipt ->> 'schemaVersion' = 'bayn.archive-record-availability.v1'),
      CHECK (receipt ->> 'recordId' = record_id),
      CHECK (receipt ->> 'recordContentHash' = record_content_hash),
      CHECK (receipt ->> 'receiptHash' = receipt_hash),
      CHECK (receipt -> 'reader' ->> 'endpointHash' = reader_endpoint_hash),
      CHECK (receipt -> 'reader' ->> 'verification' = verification),
      CHECK ((receipt ->> 'readStartedAt')::timestamptz = read_started_at),
      CHECK ((receipt ->> 'availableAt')::timestamptz = available_at),
      CHECK ((receipt ->> 'snapshotObservedAt')::timestamptz <= read_started_at)
    )
  `
  yield* sql`
    CREATE TRIGGER intraday_archive_availability_append_only
    BEFORE UPDATE OR DELETE ON intraday_archive_availability
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `
})
