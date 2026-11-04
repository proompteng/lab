import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Existing registrations and receipts retain their original missing binding and measured failures.
  yield* sql`CREATE FUNCTION check_operational_controller_plan() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF NEW.program='BAYN_OPERATIONAL_RELIABILITY'
      AND NEW.payload_text::jsonb #>> '{obligations,configuration,controllerPlanHash}'
        IS DISTINCT FROM '0c2f682a50bbd17fc1d780fbdb48f1dd588932f8f771474ecdce272091aaadcc' THEN
      RAISE EXCEPTION 'operational registration requires the native controller plan' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER operational_controller_plan BEFORE INSERT ON system_qualification_registrations
    FOR EACH ROW EXECUTE FUNCTION check_operational_controller_plan()`
  yield* sql`CREATE OR REPLACE FUNCTION retain_execution_controller_observation() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF NEW.last_receipt_hash IS NOT NULL AND jsonb_typeof(NEW.last_pass) = 'object'
      AND (TG_OP = 'INSERT' OR NEW.last_receipt_hash IS DISTINCT FROM OLD.last_receipt_hash
        OR NEW.last_sequence IS DISTINCT FROM OLD.last_sequence OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
        OR NEW.last_pass IS DISTINCT FROM OLD.last_pass OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash) THEN
      INSERT INTO execution_controller_observations(controller_key, status) VALUES (NEW.controller_key, to_jsonb(NEW));
    ELSE
      PERFORM witness_committed_system_evidence(NEW.controller_key, NEW.plan_hash);
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE FUNCTION witness_committed_system_evidence(s_controller text, s_plan text) RETURNS void LANGUAGE plpgsql AS $function$
  DECLARE registration record; account text; controller_identity text; generation text;
    observed_at timestamptz := clock_timestamp();
  BEGIN
    IF pg_trigger_depth() = 0 THEN
      RAISE EXCEPTION 'durable evidence requires a controller observation trigger' USING ERRCODE='55000';
    END IF;
    FOR registration IN SELECT * FROM system_qualification_registrations
      WHERE first_open_at <= observed_at AND last_close_at >= observed_at - interval '1 day'
        AND payload_text::jsonb #>> '{obligations,configuration,controllerPlanHash}' = s_plan LOOP
      SELECT policy->>'authorityGenerationHash' INTO generation
        FROM jsonb_array_elements(registration.payload_text::jsonb->'policies') policy WHERE policy->>'policy' = 'JEV';
      SELECT account_id, broker_identity_hash INTO account, controller_identity FROM authority_generations WHERE generation_hash = generation;
      IF account IS NULL OR controller_identity IS DISTINCT FROM s_controller THEN CONTINUE; END IF;
      INSERT INTO system_durable_observations(registration_hash, kind, source_hash, source_at, correct)
        SELECT pending.registration_hash, pending.kind, pending.source_hash, pending.source_at, pending.correct
        FROM system_pending_evidence pending
        WHERE pending.registration_hash = registration.registration_hash AND pending.source_at <= observed_at
          AND system_evidence_source_committed(pending.xmin)
        ON CONFLICT DO NOTHING;
      DELETE FROM system_pending_evidence pending USING system_durable_observations witnessed
        WHERE pending.registration_hash = registration.registration_hash
          AND pending.registration_hash = witnessed.registration_hash AND pending.kind = witnessed.kind
          AND pending.source_hash = witnessed.source_hash;
    END LOOP;
    RETURN;
  END $function$`
  yield* sql`CREATE FUNCTION witness_execution_controller_observation() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    PERFORM witness_committed_system_evidence(NEW.controller_key, NEW.status->>'plan_hash');
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER execution_controller_observations_witness AFTER INSERT ON execution_controller_observations
    FOR EACH ROW EXECUTE FUNCTION witness_execution_controller_observation()`
})
