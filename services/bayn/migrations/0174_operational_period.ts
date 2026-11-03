import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE system_qualification_origin DROP CONSTRAINT system_qualification_origin_program_check,
    ADD CONSTRAINT system_qualification_origin_program_check CHECK (
      program IN ('BAYN_SYSTEM_QUALIFICATION', 'BAYN_OPERATIONAL_RELIABILITY'))`
  // Keep the economic contract byte-for-byte and add a distinct operational payload to the same history registry.
  yield* sql`DO $migration$
  DECLARE shape text; admission text; queue text; assessment text; policy_start integer; history_start integer;
  BEGIN
    SELECT pg_get_constraintdef(oid) INTO STRICT shape FROM pg_constraint
      WHERE conrelid='system_qualification_registrations'::regclass AND conname='system_registration_payload_shape';
    EXECUTE 'ALTER TABLE system_qualification_registrations DROP CONSTRAINT system_registration_payload_shape';
    EXECUTE 'ALTER TABLE system_qualification_registrations ADD CONSTRAINT system_registration_payload_shape CHECK ('
      || substring(shape FROM 7) || $shape$ OR ((program='BAYN_OPERATIONAL_RELIABILITY'
        AND jsonb_typeof(payload_text::jsonb)='object'
        AND payload_text::jsonb->>'schemaVersion'='bayn.operational-registration.v1'
        AND payload_text::jsonb->>'program'=program AND payload_text::jsonb->>'environment'='PAPER'
        AND payload_text::jsonb->>'policyHash'='e5c0e4e897ee752d6f95d84da83e52a088f6409dd730ebb863db325d1ffb13b8'
        AND (payload_text::jsonb->>'attemptIndex')::integer=attempt_index
        AND payload_text::jsonb->>'priorAttemptHash'=prior_attempt_hash
        AND (payload_text::jsonb->>'registeredAt')::timestamptz=registered_at
        AND (payload_text::jsonb #>> '{calendar,sessions,0,openAt}')::timestamptz=first_open_at
        AND (payload_text::jsonb #>> '{calendar,sessions,-1,closeAt}')::timestamptz=last_close_at
        AND payload_text::jsonb #>> '{calendar,operatingHours}'='NATIVE'
        AND payload_text::jsonb #>> '{calendar,referenceMarket}'='NATIVE_POLICY'
        AND jsonb_array_length(payload_text::jsonb #> '{calendar,sessions}')>0
        AND jsonb_array_length(payload_text::jsonb->'policies')=1
        AND payload_text::jsonb #>> '{policies,0,policy}'='JEV'
        AND jsonb_typeof(payload_text::jsonb #> '{policies,0,capitalAuthorization,generation}')='object'
        AND jsonb_array_length(payload_text::jsonb->'retainedIncidentSources')>0) IS TRUE))$shape$;
    SELECT pg_get_functiondef('admit_system_qualification_registration()'::regprocedure) INTO admission;
    IF strpos(admission, 'IF NEW.payload_text')=0 OR strpos(admission, 'SELECT prior_attempt_count, prior_attempt_hash INTO STRICT prior_index, prior_hash')=0 THEN
      RAISE EXCEPTION 'unexpected registration admission definition';
    END IF;
    policy_start := strpos(admission, 'IF NEW.payload_text');
    admission := substring(admission FROM 1 FOR policy_start-1) || $admission$
      IF NEW.program='BAYN_OPERATIONAL_RELIABILITY' THEN
        IF NEW.payload_text::jsonb->>'schemaVersion' IS DISTINCT FROM 'bayn.operational-registration.v1'
          OR NOT EXISTS (SELECT 1 FROM authority_generations generation
            WHERE generation.generation_hash=NEW.payload_text::jsonb #>> '{policies,0,authorityGenerationHash}'
              AND generation.account_id=NEW.payload_text::jsonb #>> '{policies,0,riskPolicy,accountId}'
              AND generation.risk_policy_hash=NEW.payload_text::jsonb #>> '{policies,0,riskPolicyHash}'
              AND generation.strategy_behavior_hash=NEW.payload_text::jsonb #>> '{policies,0,strategyHash}'
              AND generation.strategy_parameter_hash=NEW.payload_text::jsonb #>> '{policies,0,parametersHash}'
              AND generation.strategy_protocol_hash=NEW.payload_text::jsonb #>> '{policies,0,protocolHash}') THEN
          RAISE EXCEPTION 'operational registration requires its existing authorized generation' USING ERRCODE='23514';
        END IF;
      ELSE
       $admission$ || substring(admission FROM policy_start);
    history_start := strpos(admission, 'SELECT prior_attempt_count, prior_attempt_hash INTO STRICT prior_index, prior_hash');
    admission := substring(admission FROM 1 FOR history_start-1) || 'END IF; ' || substring(admission FROM history_start);
    EXECUTE admission;
    SELECT pg_get_functiondef('check_system_assessment_scope()'::regprocedure) INTO assessment;
    EXECUTE replace(assessment, 'RETURN NEW;',
      'IF registration.program <> ''BAYN_SYSTEM_QUALIFICATION'' THEN
        RAISE EXCEPTION ''operational periods cannot establish economic qualification'' USING ERRCODE=''23514'';
      END IF; RETURN NEW;');
    SELECT pg_get_functiondef('queue_system_evidence(text,text,timestamptz,timestamptz,timestamptz,text,text,text,text,boolean)'::regprocedure) INTO queue;
    EXECUTE replace(queue, 'registration.last_close_at',
      '(registration.last_close_at + CASE WHEN registration.program=''BAYN_OPERATIONAL_RELIABILITY''
        THEN make_interval(secs => greatest(
          (registration.payload_text::jsonb #>> ''{obligations,decisionWindowMs}'')::double precision,
          (registration.payload_text::jsonb #>> ''{obligations,reconciliationFreshnessMs}'')::double precision)/1000)
        ELSE interval ''0'' END)');
  END $migration$`
  yield* sql`CREATE TABLE operational_assessment_receipts (
    assessment_hash text PRIMARY KEY,
    registration_hash text NOT NULL REFERENCES system_qualification_registrations(registration_hash),
    source_cut_hash text NOT NULL REFERENCES system_evidence_cuts(source_cut_hash),
    as_of timestamptz NOT NULL,
    verdict text NOT NULL CHECK (verdict IN ('OPERATIONALLY_RELIABLE_PAPER','REJECTED','INCONCLUSIVE')),
    input_text text NOT NULL, assessment_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (assessment_hash=encode(sha256(convert_to(assessment_text,'UTF8')),'hex')),
    CHECK ((assessment_text::jsonb->>'schemaVersion'='bayn.operational-assessment.v1'
      AND assessment_text::jsonb->>'registrationHash'=registration_hash
      AND assessment_text::jsonb->>'sourceCutHash'=source_cut_hash
      AND (assessment_text::jsonb->>'asOf')::timestamptz=as_of
      AND assessment_text::jsonb->>'verdict'=verdict
      AND assessment_text::jsonb->>'economicQualification'='NOT_ASSESSED') IS TRUE)
  )`
  yield* sql`CREATE FUNCTION check_operational_assessment_scope() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE registration system_qualification_registrations; source system_evidence_cuts;
  BEGIN
    SELECT * INTO STRICT registration FROM system_qualification_registrations WHERE registration_hash=NEW.registration_hash;
    SELECT * INTO STRICT source FROM system_evidence_cuts WHERE source_cut_hash=NEW.source_cut_hash;
    NEW.created_at:=clock_timestamp();
    IF registration.program<>'BAYN_OPERATIONAL_RELIABILITY' OR source.registration_hash<>NEW.registration_hash
      OR source.as_of<>NEW.as_of OR NEW.as_of>NEW.created_at
      OR NEW.input_text::jsonb->'registration' IS DISTINCT FROM registration.payload_text::jsonb
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
  yield* sql`CREATE TRIGGER operational_assessment_scope BEFORE INSERT ON operational_assessment_receipts
    FOR EACH ROW EXECUTE FUNCTION check_operational_assessment_scope()`
  yield* sql`CREATE TRIGGER operational_assessment_receipts_immutable BEFORE UPDATE OR DELETE ON operational_assessment_receipts
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER operational_assessment_receipts_no_truncate BEFORE TRUNCATE ON operational_assessment_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
