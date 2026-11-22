import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE FUNCTION system_native_qualification_calendar_valid(payload json) RETURNS boolean
    LANGUAGE plpgsql STABLE AS $calendar$
    DECLARE registration jsonb := payload::jsonb; calendar jsonb := registration->'calendar';
      evidence_json json := payload #> '{calendar,marketCalendar}'; evidence jsonb := evidence_json::jsonb;
      normalized_hash text; days integer;
    BEGIN
      IF NOT ((
        calendar->>'referenceMarket'='US_EQUITIES' AND calendar->>'operatingHours'='NATIVE'
        AND calendar->>'sourceHash'=encode(sha256(convert_to(evidence_json::text,'UTF8')),'hex')
        AND registration #> '{obligations,configuration,entryMarkets}'='["EQUITY"]'::jsonb
        AND evidence->>'schemaVersion'='bayn.alpaca-market-calendar-observation.v2'
        AND evidence->>'source'='alpaca-v2-calendar' AND evidence->>'timeZone'='UTC'
        AND evidence->>'normalizedResponseHash' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(calendar->'sessions')='array'
        AND jsonb_typeof(evidence->'sessions')='array' AND jsonb_typeof(evidence->'providerSessions')='array'
      ) IS TRUE) THEN RETURN false; END IF;

      -- Retain the original canonical JSON for nested values. JSONB rewrites object key order and spacing.
      SELECT encode(sha256(convert_to('{' || string_agg(to_json(key)::text || ':' || value::text, ','
        ORDER BY key COLLATE "C") || '}', 'UTF8')), 'hex') INTO normalized_hash
      FROM json_each(evidence_json) WHERE key <> 'normalizedResponseHash';
      IF evidence->>'normalizedResponseHash' IS DISTINCT FROM normalized_hash THEN RETURN false; END IF;

      days := jsonb_array_length(calendar->'sessions');
      IF days=0 OR days<>jsonb_array_length(evidence->'sessions')
        OR days<>jsonb_array_length(evidence->'providerSessions')
        OR evidence #>> '{requestedRange,start}' IS DISTINCT FROM calendar #>> '{sessions,0,sessionDate}'
        OR evidence #>> '{requestedRange,end}' IS DISTINCT FROM calendar #>> '{sessions,-1,sessionDate}'
      THEN RETURN false; END IF;

      RETURN NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(calendar->'sessions') WITH ORDINALITY AS planned(session, i)
        JOIN jsonb_array_elements(evidence->'sessions') WITH ORDINALITY AS native(session, i) USING(i)
        JOIN jsonb_array_elements(evidence->'providerSessions') WITH ORDINALITY AS provider(session, i) USING(i)
        CROSS JOIN LATERAL (
          SELECT (provider.session->>'date')::date AS day,
                 (provider.session->>'sessionOpenAt')::timestamptz AS broker_open,
                 (provider.session->>'regularOpenAt')::timestamptz AS regular_open,
                 (provider.session->>'regularCloseAt')::timestamptz AS regular_close,
                 (provider.session->>'sessionCloseAt')::timestamptz AS broker_close
        ) bounds
        WHERE NOT ((
          planned.session->>'sessionDate'=provider.session->>'date'
          AND native.session->>'date'=provider.session->>'date'
          AND (planned.i=1 OR calendar #>> ARRAY['sessions',(planned.i-2)::text,'sessionDate'] < planned.session->>'sessionDate')
          AND bounds.broker_open<=bounds.regular_open AND bounds.regular_open<bounds.regular_close
          AND bounds.regular_close<=bounds.broker_close
          AND (bounds.broker_open AT TIME ZONE 'America/New_York')::date=bounds.day
          AND (bounds.broker_close AT TIME ZONE 'America/New_York')::date=bounds.day
          AND (planned.session->>'openAt')::timestamptz=(native.session->>'openAt')::timestamptz
          AND (planned.session->>'closeAt')::timestamptz=(native.session->>'closeAt')::timestamptz
          AND (planned.session->>'openAt')::timestamptz=greatest(
            bounds.broker_open, (bounds.day + time '08:00') AT TIME ZONE 'America/New_York')
          AND (planned.session->>'closeAt')::timestamptz=least(
            bounds.broker_close, (bounds.day + time '17:00') AT TIME ZONE 'America/New_York')
          AND (planned.session->>'openAt')::timestamptz<(planned.session->>'closeAt')::timestamptz
        ) IS TRUE)
      );
    END $calendar$`

  // Preserve the stored shapes and the existing admission, risk, and attempt-history checks.
  yield* sql`DO $migration$
  DECLARE shape text; admission text; assessment text; retained text := 'bayn.system-registration.v4';
    current_version text := 'bayn.system-registration.v5';
    retained_hash text := '19024af2ef4b02c8a63e011149e2e2df07e4846e7903ca31baaf34100b88b9b8';
    current_hash text := '3bcca8feb62f42e6f5df33cb875630e6c4c5419bfb1b71fbae68661a3f1e238b';
    retained_roles text := '''JEV'',''DEPLOYED_BAYN'',''REPEATED_MOMENTUM'',''JEV_ABLATION''';
  BEGIN
    SELECT pg_get_constraintdef(oid) INTO STRICT shape FROM pg_constraint
      WHERE conrelid='system_qualification_registrations'::regclass AND conname='system_registration_payload_shape';
    SELECT pg_get_functiondef('admit_system_qualification_registration()'::regprocedure) INTO STRICT admission;
    SELECT pg_get_functiondef('check_system_assessment_scope()'::regprocedure) INTO STRICT assessment;
    IF strpos(shape,quote_literal(retained) || '::text')=0
      OR strpos(admission,quote_literal(retained))=0 OR strpos(admission,retained_hash)=0
      OR strpos(admission,retained_roles)=0 OR strpos(assessment,quote_literal(retained))=0
    THEN RAISE EXCEPTION 'unexpected prior system qualification contract'; END IF;

    EXECUTE 'ALTER TABLE system_qualification_registrations DROP CONSTRAINT system_registration_payload_shape';
    EXECUTE 'ALTER TABLE system_qualification_registrations ADD CONSTRAINT system_registration_payload_shape '
      || replace(shape, quote_literal(retained) || '::text',
         'ANY (ARRAY[' || quote_literal(retained) || '::text,' || quote_literal(current_version) || '::text])');
    admission := replace(replace(admission, retained, current_version), retained_hash, current_hash);
    admission := replace(admission, retained_roles, retained_roles || ',''INCUMBENT_JEV''');
    EXECUTE replace(admission,'NEW.created_at := clock_timestamp();',$admission$
      IF NEW.program='BAYN_SYSTEM_QUALIFICATION'
        AND NOT system_native_qualification_calendar_valid(NEW.payload_text::json) THEN
        RAISE EXCEPTION 'registration must match the complete canonical native equity calendar' USING ERRCODE='23514';
      END IF;
      IF NEW.program='BAYN_SYSTEM_QUALIFICATION' AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') AS candidate
        CROSS JOIN jsonb_array_elements(NEW.payload_text::jsonb->'policies') AS incumbent
        WHERE candidate->>'policy'='JEV' AND incumbent->>'policy'='INCUMBENT_JEV'
          AND candidate->>'accountBindingHash' <> incumbent->>'accountBindingHash'
          AND candidate->>'authorityGenerationHash' <> incumbent->>'authorityGenerationHash'
          AND ((candidate->'riskPolicy') - 'accountId'::text) = ((incumbent->'riskPolicy') - 'accountId'::text)
      ) THEN
        RAISE EXCEPTION 'native qualification requires an independent serving Jev comparator with the same risk'
          USING ERRCODE='23514';
      END IF;
      NEW.created_at := clock_timestamp();
    $admission$);
    assessment := replace(assessment,
      'registration.payload_text::jsonb->>''schemaVersion''=' || quote_literal(retained),
      'registration.payload_text::jsonb->>''schemaVersion'' IN (' || quote_literal(retained) || ',' || quote_literal(current_version) || ')');
    EXECUTE replace(assessment,'RETURN NEW;',$assessment$
      IF registration.payload_text::jsonb->>'schemaVersion'='bayn.system-registration.v5'
        AND (NEW.verdict='QUALIFIED_PAPER' OR NEW.assessment_text::jsonb #>> '{edge,status}'='ESTABLISHED_UNDER_PROTOCOL')
        AND NEW.as_of < (registration.payload_text::jsonb #>> '{calendar,marketCalendar,providerSessions,-1,sessionCloseAt}')::timestamptz THEN
        RAISE EXCEPTION 'qualification requires the complete broker recovery window' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    $assessment$);
  END $migration$`
})
