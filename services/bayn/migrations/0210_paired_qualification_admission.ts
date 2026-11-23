import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE qualification_incumbent_witnesses (
    registration_hash text PRIMARY KEY CHECK (registration_hash ~ '^[0-9a-f]{64}$'),
    admitted_at timestamptz NOT NULL,
    first_open_at timestamptz NOT NULL CHECK (admitted_at < first_open_at),
    generation_hash text NOT NULL REFERENCES authority_generations(generation_hash),
    authority_version bigint NOT NULL CHECK (authority_version > 0)
  )`
  yield* sql`CREATE FUNCTION capture_qualification_incumbent_witness() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      SELECT a.version INTO NEW.authority_version
      FROM authority_state a JOIN authority_generations g USING (generation_hash)
      WHERE a.singleton AND g.generation_hash = NEW.generation_hash
        AND a.effective = 'PAPER' AND a.kill_state = 'CLEAR'
        AND g.maximum = 'PAPER' AND g.strategy_name = 'jev' AND g.broker_environment = 'sandbox'
      FOR SHARE OF a;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'qualification requires the serving PAPER Jev incumbent' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$`
  yield* sql`CREATE TRIGGER qualification_incumbent_witness_capture BEFORE INSERT ON qualification_incumbent_witnesses
    FOR EACH ROW EXECUTE FUNCTION capture_qualification_incumbent_witness()`
  yield* sql`CREATE TABLE qualification_pair_seals (
    registration_hash text PRIMARY KEY REFERENCES system_qualification_registrations(registration_hash),
    admitted_at timestamptz NOT NULL,
    first_open_at timestamptz NOT NULL,
    generation_hash text NOT NULL CHECK (generation_hash ~ '^[0-9a-f]{64}$'),
    authority_version bigint NOT NULL CHECK (authority_version > 0)
  )`
  yield* sql`CREATE FUNCTION check_qualification_pair_seal() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM system_qualification_registrations r
        CROSS JOIN LATERAL jsonb_array_elements(r.payload_text::jsonb->'policies') p
        WHERE r.registration_hash = NEW.registration_hash AND r.created_at = NEW.admitted_at
          AND r.first_open_at = NEW.first_open_at AND r.payload_text::jsonb->>'schemaVersion' = 'bayn.system-registration.v5'
          AND p->>'policy' = 'INCUMBENT_JEV' AND p->>'authorityGenerationHash' = NEW.generation_hash
      ) THEN
        RAISE EXCEPTION 'qualification seal differs from the candidate registration' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$`
  yield* sql`CREATE TRIGGER qualification_pair_seal_scope BEFORE INSERT ON qualification_pair_seals
    FOR EACH ROW EXECUTE FUNCTION check_qualification_pair_seal()`
  for (const table of ['qualification_incumbent_witnesses', 'qualification_pair_seals']) {
    yield* sql`CREATE CONSTRAINT TRIGGER ${sql(`${table}_deadline`)} AFTER INSERT ON ${sql(table)}
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_system_registration_commit_deadline()`
    yield* sql`CREATE TRIGGER ${sql(`${table}_immutable`)} BEFORE UPDATE OR DELETE ON ${sql(table)}
      FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
    yield* sql`CREATE TRIGGER ${sql(`${table}_no_truncate`)} BEFORE TRUNCATE ON ${sql(table)}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  }
})
