import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE FUNCTION system_conditional_qualification_evidence_valid(registered jsonb, assessed jsonb)
    RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $function$
      SELECT ((assessed #>> '{numerical,confidence,method}'='CONDITIONAL_HOEFFDING_V1'
          AND assessed #>> '{numerical,confidence,meanModel}'='DETERMINISTIC_CONDITIONAL_SESSION_MEANS'
          AND registered #>> '{statisticalPlan,meanModel}'=assessed #>> '{numerical,confidence,meanModel}'
          AND assessed #>> '{numerical,confidence,estimand}'='AVERAGE_REGISTERED_EXPECTED_SESSION_NET'
          AND assessed #>> '{numerical,confidence,alpha,numerator}'='1'
          AND (assessed #>> '{numerical,confidence,attemptIndex}')::integer=(registered->>'attemptIndex')::numeric
          AND (assessed #>> '{numerical,confidence,alpha,denominator}')::numeric=
            20::numeric*(registered->>'attemptIndex')::numeric*((registered->>'attemptIndex')::numeric+1)*jsonb_array_length(registered->'policies')
          AND assessed #> '{numerical,confidence,supports}'=registered #> '{statisticalPlan,supports}'
          AND (assessed #>> '{numerical,confidence,profit,count}')::integer=jsonb_array_length(registered #> '{calendar,sessions}')
          AND (assessed->>'verdict'<>'QUALIFIED_PAPER' OR (assessed #>> '{numerical,confidence,profit,lowerSumMicros}')::numeric>0)
          AND jsonb_array_length(assessed #> '{numerical,confidence,paired}')=jsonb_array_length(registered->'policies')-1
          AND (SELECT count(DISTINCT p->>'control') FROM jsonb_array_elements(assessed #> '{numerical,confidence,paired}') p)=jsonb_array_length(registered->'policies')-1

          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(assessed #> '{numerical,confidence,paired}') p
            WHERE NOT ((p->>'control'<>'JEV' AND EXISTS(SELECT 1 FROM jsonb_array_elements(registered->'policies') policy WHERE policy->>'policy'=p->>'control') AND (p->>'lowerSumMicros')::numeric>0 AND (p->>'count')::integer=jsonb_array_length(registered #> '{calendar,sessions}')) IS TRUE))) IS TRUE)
    $function$`
  // Retain every earlier constraint branch for immutable history; only the new admission identity changes.
  yield* sql`DO $migration$
  DECLARE shape text; admission text; assessment text;
  BEGIN
    SELECT pg_get_constraintdef(oid) INTO STRICT shape FROM pg_constraint
      WHERE conrelid='system_qualification_registrations'::regclass AND conname='system_registration_payload_shape';
    EXECUTE 'ALTER TABLE system_qualification_registrations DROP CONSTRAINT system_registration_payload_shape';
    EXECUTE 'ALTER TABLE system_qualification_registrations ADD CONSTRAINT system_registration_payload_shape CHECK ('
      || substring(shape FROM 7) || $shape$ OR ((program='BAYN_SYSTEM_QUALIFICATION'
        AND jsonb_typeof(payload_text::jsonb)='object'
        AND payload_text::jsonb->>'schemaVersion'='bayn.system-registration.v4'
        AND payload_text::jsonb->>'program'=program AND payload_text::jsonb->>'environment'='PAPER'
        AND (payload_text::jsonb->>'attemptIndex')::integer=attempt_index
        AND payload_text::jsonb->>'priorAttemptHash'=prior_attempt_hash
        AND (payload_text::jsonb->>'registeredAt')::timestamptz=registered_at
        AND (payload_text::jsonb #>> '{calendar,sessions,0,openAt}')::timestamptz=first_open_at
        AND (payload_text::jsonb #>> '{calendar,sessions,-1,closeAt}')::timestamptz=last_close_at
        AND jsonb_array_length(payload_text::jsonb #> '{calendar,sessions}')>0
        AND jsonb_typeof(payload_text::jsonb->'costAllocationPlans')='array'
        AND jsonb_array_length(payload_text::jsonb->'policies') BETWEEN 2 AND 4
        AND payload_text::jsonb->>'allocationMicros' ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(payload_text::jsonb->'statisticalPlan')='object'
        AND payload_text::jsonb #>> '{statisticalPlan,method}'='CONDITIONAL_HOEFFDING_V1'
        AND payload_text::jsonb #>> '{statisticalPlan,meanModel}'='DETERMINISTIC_CONDITIONAL_SESSION_MEANS'
        AND jsonb_typeof(payload_text::jsonb #> '{statisticalPlan,supports}')='array'
        AND jsonb_array_length(payload_text::jsonb #> '{statisticalPlan,supports}')=jsonb_array_length(payload_text::jsonb->'policies')
        AND NOT (payload_text::jsonb ? 'bootstrap')) IS TRUE))$shape$;
    SELECT pg_get_functiondef('admit_system_qualification_registration()'::regprocedure) INTO admission;
    IF strpos(admission,'bf7c0a91d50457aeac8a3e90d004418ffd8af93e032499baaefbd9aee0f41638')=0
      OR strpos(admission,'bayn.system-registration.v3')=0
      OR strpos(admission,'4db1624574c2175dfa6d279d4fed16e760e0e00ce5a7504bc9fe49c13caaf7a1')=0 THEN
      RAISE EXCEPTION 'unexpected prior research admission policy';
    END IF;
    admission:=replace(admission,'bayn.system-registration.v3','bayn.system-registration.v4');
    admission:=replace(admission,'bf7c0a91d50457aeac8a3e90d004418ffd8af93e032499baaefbd9aee0f41638','19024af2ef4b02c8a63e011149e2e2df07e4846e7903ca31baaf34100b88b9b8');
    admission:=replace(admission,'4db1624574c2175dfa6d279d4fed16e760e0e00ce5a7504bc9fe49c13caaf7a1','2eb1c64be5912bfa96890e64d9c01c7c555e761d9ebc759ff37646c42929ffff');
    admission:=replace(admission,'NEW.created_at := clock_timestamp();',$admission$
      IF NEW.program='BAYN_SYSTEM_QUALIFICATION' AND NOT ((
        jsonb_typeof(NEW.payload_text::jsonb #> '{statisticalPlan,supports}')='array'
        AND jsonb_array_length(NEW.payload_text::jsonb #> '{statisticalPlan,supports}')=jsonb_array_length(NEW.payload_text::jsonb->'policies')
        AND (SELECT count(DISTINCT s->>'policy') FROM jsonb_array_elements(NEW.payload_text::jsonb #> '{statisticalPlan,supports}') s)=jsonb_array_length(NEW.payload_text::jsonb->'policies')
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload_text::jsonb #> '{statisticalPlan,supports}') s
          WHERE NOT ((s->>'policy' IN ('JEV','DEPLOYED_BAYN','REPEATED_MOMENTUM','JEV_ABLATION') AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') p WHERE p->>'policy'=s->>'policy') AND s->>'sourceHash' ~ '^[a-f0-9]{64}$'
            AND jsonb_typeof(s->'assumption')='string' AND length(btrim(s->>'assumption'))>0
            AND jsonb_typeof(s->'lowerMicros')='string' AND jsonb_typeof(s->'upperMicros')='string'
            AND s->>'lowerMicros' ~ '^-?[0-9]+$' AND s->>'upperMicros' ~ '^-?[0-9]+$'
            AND (s->>'lowerMicros')::numeric <= (s->>'upperMicros')::numeric) IS TRUE))) IS TRUE) THEN
        RAISE EXCEPTION 'statistical support must be complete, distinct, ordered and prospectively sourced' USING ERRCODE='23514';
      END IF;
      NEW.created_at := clock_timestamp();
    $admission$);
    EXECUTE admission;
    SELECT pg_get_functiondef('check_system_assessment_scope()'::regprocedure) INTO assessment;
    IF strpos(assessment,'research bootstrap cannot establish statistical qualification')=0 THEN
      RAISE EXCEPTION 'missing retained research qualification guard';
    END IF;
    EXECUTE replace(assessment,'RETURN NEW;',$assessment$
      IF registration.payload_text::jsonb->>'schemaVersion'='bayn.system-registration.v4'
        AND (NEW.verdict='QUALIFIED_PAPER' OR NEW.assessment_text::jsonb #>> '{edge,status}'='ESTABLISHED_UNDER_PROTOCOL')
        AND system_conditional_qualification_evidence_valid(registration.payload_text::jsonb,NEW.assessment_text::jsonb) IS NOT TRUE THEN
        RAISE EXCEPTION 'current qualification requires its exact registered conditional bounds' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    $assessment$);
  END $migration$`
})
