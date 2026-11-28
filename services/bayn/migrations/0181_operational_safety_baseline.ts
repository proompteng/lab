import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE operational_safety_baselines (
    registration_hash text PRIMARY KEY REFERENCES system_qualification_registrations(registration_hash),
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    authority_state jsonb
  )`
  yield* sql`CREATE FUNCTION capture_operational_safety_baseline() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.program = 'BAYN_OPERATIONAL_RELIABILITY' THEN
        INSERT INTO operational_safety_baselines(registration_hash, authority_state)
        SELECT NEW.registration_hash, (SELECT to_jsonb(a) FROM authority_state a WHERE singleton);
      END IF;
      RETURN NEW;
    END
    $function$`
  yield* sql`CREATE TRIGGER capture_operational_safety_baseline
    AFTER INSERT ON system_qualification_registrations
    FOR EACH ROW EXECUTE FUNCTION capture_operational_safety_baseline()`
  yield* sql`CREATE FUNCTION reject_operational_safety_evidence_change() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      RAISE EXCEPTION 'operational safety evidence is append-only';
    END
    $function$`
  yield* sql`CREATE TRIGGER operational_safety_baseline_immutable
    BEFORE UPDATE OR DELETE ON operational_safety_baselines
    FOR EACH ROW EXECUTE FUNCTION reject_operational_safety_evidence_change()`
  yield* sql`CREATE TABLE operational_safety_authority_transitions (
    authority_version bigint PRIMARY KEY,
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    previous_state jsonb,
    authority_state jsonb NOT NULL
  )`
  yield* sql`CREATE FUNCTION capture_operational_safety_authority_transition() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      INSERT INTO operational_safety_authority_transitions(authority_version, previous_state, authority_state)
      VALUES (NEW.version, CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END, to_jsonb(NEW));
      RETURN NEW;
    END
    $function$`
  yield* sql`CREATE TRIGGER capture_operational_safety_authority_transition AFTER INSERT OR UPDATE ON authority_state
    FOR EACH ROW EXECUTE FUNCTION capture_operational_safety_authority_transition()`
  yield* sql`CREATE TRIGGER operational_safety_authority_transitions_immutable
    BEFORE UPDATE OR DELETE ON operational_safety_authority_transitions
    FOR EACH ROW EXECUTE FUNCTION reject_operational_safety_evidence_change()`
  yield* sql`CREATE TABLE operational_safety_mutation_admissions (
    event_id text PRIMARY KEY REFERENCES mutation_events(event_id),
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    authority_state jsonb
  )`
  yield* sql`CREATE FUNCTION capture_operational_safety_mutation_admission() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.event_type IN ('SUBMIT_STARTED', 'CANCEL_STARTED') THEN
        INSERT INTO operational_safety_mutation_admissions(event_id, authority_state)
        SELECT NEW.event_id, (SELECT to_jsonb(a) FROM authority_state a WHERE singleton);
      END IF;
      RETURN NEW;
    END
    $function$`
  yield* sql`CREATE TRIGGER capture_operational_safety_mutation_admission AFTER INSERT ON mutation_events
    FOR EACH ROW EXECUTE FUNCTION capture_operational_safety_mutation_admission()`
  yield* sql`CREATE TRIGGER operational_safety_mutation_admissions_immutable
    BEFORE UPDATE OR DELETE ON operational_safety_mutation_admissions
    FOR EACH ROW EXECUTE FUNCTION reject_operational_safety_evidence_change()`
  for (const table of [
    'operational_safety_baselines',
    'operational_safety_authority_transitions',
    'operational_safety_mutation_admissions',
  ]) {
    yield* sql`CREATE TRIGGER ${sql(`${table}_no_truncate`)} BEFORE TRUNCATE ON ${sql(table)}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_operational_safety_evidence_change()`
  }
  yield* sql`CREATE FUNCTION check_operational_safety_evidence_insert() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'operational safety evidence must come from its original transaction' USING ERRCODE='23514';
      END IF;
      NEW.captured_at := clock_timestamp();
      RETURN NEW;
    END
    $function$`
  for (const table of [
    'operational_safety_baselines',
    'operational_safety_authority_transitions',
    'operational_safety_mutation_admissions',
  ]) {
    yield* sql`CREATE TRIGGER ${sql(`${table}_native_insert`)} BEFORE INSERT ON ${sql(table)}
      FOR EACH ROW EXECUTE FUNCTION check_operational_safety_evidence_insert()`
  }
  yield* sql`CREATE OR REPLACE FUNCTION check_operational_assessment_scope() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE registration system_qualification_registrations; source system_evidence_cuts;
  BEGIN
    SELECT * INTO STRICT registration FROM system_qualification_registrations WHERE registration_hash=NEW.registration_hash;
    SELECT * INTO STRICT source FROM system_evidence_cuts WHERE source_cut_hash=NEW.source_cut_hash;
    NEW.created_at:=clock_timestamp();
    IF registration.program<>'BAYN_OPERATIONAL_RELIABILITY' OR source.registration_hash<>NEW.registration_hash
      OR source.as_of<>NEW.as_of OR NEW.as_of>NEW.created_at
      OR NEW.input_text::jsonb->'registration' IS DISTINCT FROM registration.payload_text::jsonb
      OR (CASE WHEN NEW.input_text::jsonb->>'schemaVersion'='bayn.operational-assessment-input.v3' THEN
        NEW.input_text::jsonb ? 'safety'
        OR NEW.assessment_text::jsonb->>'evaluationPolicy' IS DISTINCT FROM 'bayn.operational-native-safety.v1'
        OR NEW.assessment_text::jsonb #>> '{nativeSafetyAudit,sourceCutHash}' IS DISTINCT FROM NEW.source_cut_hash
        OR NEW.assessment_text::jsonb #>> '{nativeSafetyAudit,registrationHash}' IS DISTINCT FROM NEW.registration_hash
        OR NEW.assessment_text::jsonb #>> '{nativeSafetyAudit,asOf}' IS DISTINCT FROM NEW.assessment_text::jsonb->>'asOf'
        OR NEW.assessment_text::jsonb #>> '{nativeSafetyAudit,coverage}' IS DISTINCT FROM NEW.assessment_text::jsonb #>> '{safety,coverage}'
        OR NEW.assessment_text::jsonb #>> '{nativeSafetyAudit,evidenceHash}' IS DISTINCT FROM NEW.assessment_text::jsonb #>> '{safety,auditEvidenceHash}'
        ELSE NEW.input_text::jsonb->'safety' IS DISTINCT FROM (NEW.assessment_text::jsonb->'safety')-'pass' END)
      OR (NEW.verdict='OPERATIONALLY_RELIABLE_PAPER' AND NEW.as_of<registration.last_close_at) THEN
      RAISE EXCEPTION 'operational assessment evidence scope differs' USING ERRCODE='23514';
    END IF;
    IF NEW.verdict='OPERATIONALLY_RELIABLE_PAPER' AND NOT ((
      NEW.assessment_text::jsonb #>> '{reliability,status}'='MEETS_TARGET'
      AND NEW.assessment_text::jsonb #>> '{reliability,target,numerator}'='999'
      AND NEW.assessment_text::jsonb #>> '{reliability,target,denominator}'='1000'
      AND NEW.assessment_text::jsonb #>> '{safety,pass}'='true'
      AND NEW.assessment_text::jsonb #>> '{safety,coverage}'='COMPLETE'
      AND jsonb_array_length(NEW.assessment_text::jsonb #> '{safety,violations}')=0
      AND jsonb_array_length(NEW.assessment_text::jsonb->'missing')=0
      AND jsonb_array_length(NEW.assessment_text::jsonb #> '{reliability,classes}')=4
      AND (SELECT count(DISTINCT c->>'class') FROM jsonb_array_elements(NEW.assessment_text::jsonb #> '{reliability,classes}') c)=4
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.assessment_text::jsonb #> '{reliability,classes}') c
        WHERE NOT ((c->>'class' IN ('DECISION','RECONCILIATION','MUTATION','RECOVERY')
          AND c->>'scheduled' ~ '^[0-9]+$' AND c->>'correctOnTime' ~ '^[0-9]+$'
          AND c->>'pending'='0'
          AND ((c->>'status'='MEETS_TARGET' AND (c->>'scheduled')::numeric>0
            AND (c->>'correctOnTime')::numeric<=(c->>'scheduled')::numeric
            AND 1000*(c->>'correctOnTime')::numeric>=999*(c->>'scheduled')::numeric)
            OR (c->>'class'='RECOVERY' AND c->>'status'='NOT_APPLICABLE'
              AND c->>'scheduled'='0' AND c->>'correctOnTime'='0'))) IS TRUE))
    ) IS TRUE) THEN
      RAISE EXCEPTION 'operational success requires complete reliability and zero safety violations' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END $function$`
})
