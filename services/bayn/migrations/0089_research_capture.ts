import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE research_capture_chunks (
      chunk_id text PRIMARY KEY CHECK (chunk_id ~ '^[0-9a-f]{64}$'),
      capture_id text NOT NULL CHECK (length(capture_id) BETWEEN 1 AND 512),
      chunk_ordinal bigint NOT NULL CHECK (chunk_ordinal BETWEEN 0 AND 9007199254740991),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      payload text NOT NULL CHECK (
        octet_length(payload) BETWEEN 1 AND 4194304
        AND encode(sha256(convert_to(payload, 'UTF8')), 'hex') = content_hash
        AND payload::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.research-capture-chunk.v1'
        AND payload::jsonb->>'captureId' IS NOT DISTINCT FROM capture_id
        AND payload::jsonb->>'chunkOrdinal' IS NOT DISTINCT FROM chunk_ordinal::text
      ),
      UNIQUE (capture_id, chunk_ordinal)
    )
  `
  yield* sql`
    CREATE TABLE research_capture_seals (
      capture_id text PRIMARY KEY CHECK (length(capture_id) BETWEEN 1 AND 512),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      payload text NOT NULL CHECK (
        octet_length(payload) BETWEEN 1 AND 65536
        AND encode(sha256(convert_to(payload, 'UTF8')), 'hex') = content_hash
        AND payload::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.research-capture-seal.v1'
        AND payload::jsonb->>'captureId' IS NOT DISTINCT FROM capture_id
      )
    )
  `
  yield* sql`
    CREATE FUNCTION research_capture_append_boundary() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.capture_id, 0));
      IF TG_TABLE_NAME = 'research_capture_chunks' AND EXISTS (
        SELECT 1 FROM research_capture_seals WHERE capture_id = NEW.capture_id
      ) THEN
        RAISE EXCEPTION 'research capture is already sealed' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $body$
  `
  yield* sql`CREATE TRIGGER research_capture_chunks_open BEFORE INSERT ON research_capture_chunks
    FOR EACH ROW EXECUTE FUNCTION research_capture_append_boundary()`
  yield* sql`CREATE TRIGGER research_capture_seals_boundary BEFORE INSERT ON research_capture_seals
    FOR EACH ROW EXECUTE FUNCTION research_capture_append_boundary()`
  yield* sql`CREATE TRIGGER research_capture_chunks_immutable BEFORE UPDATE OR DELETE ON research_capture_chunks
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER research_capture_chunks_reject_truncate BEFORE TRUNCATE ON research_capture_chunks
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER research_capture_seals_immutable BEFORE UPDATE OR DELETE ON research_capture_seals
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER research_capture_seals_reject_truncate BEFORE TRUNCATE ON research_capture_seals
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
