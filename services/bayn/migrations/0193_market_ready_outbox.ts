import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE market_ready_events (
    position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id text NOT NULL UNIQUE CHECK (event_id ~ '^[a-f0-9]{64}$'),
    controller_key text NOT NULL CHECK (controller_key ~ '^[a-f0-9]{64}$'),
    source_revision text NOT NULL,
    capture_id text NOT NULL REFERENCES native_arrival_epochs(capture_id),
    content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    payload text NOT NULL
  )`
  yield* sql`CREATE INDEX market_ready_pending ON market_ready_events(controller_key,source_revision,position DESC)`
  yield* sql`CREATE TABLE market_ready_delivery_cursors (
    controller_key text NOT NULL,
    source_revision text NOT NULL,
    position bigint NOT NULL REFERENCES market_ready_events(position),
    PRIMARY KEY(controller_key,source_revision)
  )`
  yield* sql`CREATE TRIGGER market_ready_events_immutable BEFORE UPDATE OR DELETE ON market_ready_events
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER market_ready_events_no_truncate BEFORE TRUNCATE ON market_ready_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
