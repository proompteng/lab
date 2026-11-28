import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE native_arrival_epochs (
    capture_id text PRIMARY KEY CHECK (capture_id ~ '^[0-9a-f]{64}$'),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    payload text NOT NULL CHECK (
      octet_length(payload) BETWEEN 1 AND 262144
      AND encode(sha256(convert_to(payload, 'UTF8')), 'hex') = content_hash
      AND payload::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.native-arrival-epoch.v1'
      AND payload::jsonb->>'captureId' IS NOT DISTINCT FROM capture_id
    ),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`
  yield* sql`CREATE TABLE native_arrival_chunks (
    capture_id text NOT NULL REFERENCES native_arrival_epochs (capture_id),
    ordinal bigint NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
    content_hash text NOT NULL UNIQUE CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    header text NOT NULL CHECK ((
      octet_length(header) BETWEEN 1 AND 4096
      AND encode(sha256(convert_to(header, 'UTF8')), 'hex') = content_hash
      AND header::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.native-arrival-chunk.v1'
      AND header::jsonb->>'captureId' IS NOT DISTINCT FROM capture_id
      AND header::jsonb->>'ordinal' IS NOT DISTINCT FROM ordinal::text
      AND (header::jsonb->>'firstConsumerSequence')::numeric >= 1
      AND (header::jsonb->>'lastConsumerSequence')::numeric >= (header::jsonb->>'firstConsumerSequence')::numeric
      AND (header::jsonb->>'firstAvailableAtMs')::numeric <= (header::jsonb->>'lastAvailableAtMs')::numeric
      AND (header::jsonb->>'uncompressedBytes')::numeric BETWEEN 1 AND 4194304
      AND header::jsonb->>'recordsHash' ~ '^[0-9a-f]{64}$'
    ) IS TRUE),
    compressed bytea NOT NULL CHECK (
      octet_length(compressed) BETWEEN 1 AND 4194304
      AND encode(sha256(compressed), 'hex') IS NOT DISTINCT FROM header::jsonb->>'compressedHash'
    ),
    PRIMARY KEY (capture_id, ordinal)
  )`
  yield* sql`CREATE TABLE native_arrival_ends (
    capture_id text PRIMARY KEY REFERENCES native_arrival_epochs (capture_id),
    payload jsonb NOT NULL CHECK ((
      payload->>'captureId' IS NOT DISTINCT FROM capture_id
      AND payload->>'status' IN ('STOPPED', 'INCOMPLETE')
      AND (payload->>'observedConsumerSequence')::numeric >= (payload->>'durableConsumerSequence')::numeric
      AND (payload->>'durableConsumerSequence')::numeric >= 0
      AND jsonb_typeof(payload->'consumerScopeCompleted') = 'boolean'
      AND (payload->>'status' <> 'STOPPED' OR (
        payload->>'observedConsumerSequence' = payload->>'durableConsumerSequence'
        AND payload->'reason' = 'null'::jsonb
      ))
    ) IS TRUE),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`
  yield* sql`CREATE FUNCTION native_arrival_append_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
    DECLARE prior native_arrival_chunks; material jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.capture_id, 49181));
      SELECT * INTO prior FROM native_arrival_chunks WHERE capture_id=NEW.capture_id ORDER BY ordinal DESC LIMIT 1;
      IF TG_TABLE_NAME = 'native_arrival_chunks' THEN
        IF EXISTS (SELECT 1 FROM native_arrival_ends WHERE capture_id=NEW.capture_id) THEN
          RAISE EXCEPTION 'native arrival epoch is already stopped' USING ERRCODE='55000';
        END IF;
        material := NEW.header::jsonb;
        IF NEW.ordinal IS DISTINCT FROM coalesce(prior.ordinal + 1, 0)
          OR (material->>'firstConsumerSequence')::numeric IS DISTINCT FROM coalesce((prior.header::jsonb->>'lastConsumerSequence')::numeric + 1, 1)
          OR material->>'previousHash' IS DISTINCT FROM prior.content_hash
          OR (prior.ordinal IS NOT NULL AND (material->>'firstAvailableAtMs')::numeric < (prior.header::jsonb->>'lastAvailableAtMs')::numeric)
        THEN RAISE EXCEPTION 'native arrival chunk does not extend the exact ordered prefix' USING ERRCODE='23514'; END IF;
      ELSE
        material := NEW.payload;
        IF (material->>'durableConsumerSequence')::numeric IS DISTINCT FROM coalesce((prior.header::jsonb->>'lastConsumerSequence')::numeric, 0)
          OR material->>'lastChunkHash' IS DISTINCT FROM prior.content_hash
        THEN RAISE EXCEPTION 'native arrival stop differs from the durable prefix' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    END $guard$`
  yield* sql`CREATE TRIGGER native_arrival_chunks_prefix BEFORE INSERT ON native_arrival_chunks
    FOR EACH ROW EXECUTE FUNCTION native_arrival_append_guard()`
  yield* sql`CREATE TRIGGER native_arrival_ends_prefix BEFORE INSERT ON native_arrival_ends
    FOR EACH ROW EXECUTE FUNCTION native_arrival_append_guard()`
  for (const table of ['native_arrival_epochs', 'native_arrival_chunks', 'native_arrival_ends']) {
    yield* sql.unsafe(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`)
    yield* sql.unsafe(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`)
  }
})
