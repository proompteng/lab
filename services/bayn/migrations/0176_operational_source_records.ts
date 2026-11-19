import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE system_source_records (
    record_hash text PRIMARY KEY CHECK (record_hash ~ '^[0-9a-f]{64}$'),
    kind text NOT NULL CHECK (kind IN ('DECISION', 'CONTROLLER')),
    payload_text text NOT NULL CHECK (jsonb_typeof(payload_text::jsonb)='object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (record_hash=encode(sha256(convert_to(
      'bayn.system-source-record.v1:' || kind || ':' || payload_text, 'UTF8')), 'hex'))
  )`
  yield* sql`CREATE TRIGGER system_source_records_immutable BEFORE UPDATE OR DELETE ON system_source_records
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER system_source_records_no_truncate BEFORE TRUNCATE ON system_source_records
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`DO $migration$
  DECLARE constraint_name text; shape text;
  BEGIN
    SELECT conname, pg_get_constraintdef(oid) INTO STRICT constraint_name, shape
      FROM pg_constraint WHERE conrelid='system_evidence_cuts'::regclass
        AND pg_get_constraintdef(oid) LIKE '%bayn.system-source-cut.v4%';
    EXECUTE format('ALTER TABLE system_evidence_cuts DROP CONSTRAINT %I', constraint_name);
    EXECUTE 'ALTER TABLE system_evidence_cuts ADD CONSTRAINT system_source_cut_payload_shape CHECK ('
      || substring(shape FROM 7) || $shape$ OR ((jsonb_typeof(payload_text::jsonb)='object'
        AND payload_text::jsonb->>'schemaVersion'='bayn.operational-source-cut.v1'
        AND payload_text::jsonb->>'registrationHash' IS NOT DISTINCT FROM registration_hash
        AND (payload_text::jsonb->>'asOf')::timestamptz IS NOT DISTINCT FROM as_of
        AND jsonb_typeof(payload_text::jsonb->'records')='array') IS TRUE))$shape$;
  END $migration$`
  yield* sql`CREATE FUNCTION check_operational_source_records() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE reference jsonb; program_name text;
  BEGIN
    IF NEW.payload_text::jsonb->>'schemaVersion'='bayn.operational-source-cut.v1' THEN
      SELECT program INTO STRICT program_name FROM system_qualification_registrations
        WHERE registration_hash=NEW.registration_hash;
      IF program_name<>'BAYN_OPERATIONAL_RELIABILITY' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.payload_text::jsonb->'records') AS item
        GROUP BY item->>'kind', item->>'sourceId' HAVING count(*)>1
      ) THEN
        RAISE EXCEPTION 'operational source cut requires its own registration and unique source identities' USING ERRCODE='23514';
      END IF;
      FOR reference IN SELECT value FROM jsonb_array_elements(NEW.payload_text::jsonb->'records') LOOP
        IF NOT EXISTS (SELECT 1 FROM system_source_records
          WHERE record_hash=reference->>'recordHash' AND kind=reference->>'kind') THEN
          RAISE EXCEPTION 'operational source cut requires every archived source record' USING ERRCODE='23514';
        END IF;
      END LOOP;
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER operational_source_records_scope BEFORE INSERT ON system_evidence_cuts
    FOR EACH ROW EXECUTE FUNCTION check_operational_source_records()`
})
