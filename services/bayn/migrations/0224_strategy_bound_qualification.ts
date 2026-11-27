import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE FUNCTION system_strategy_bound_registration_valid(payload json) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT AS $function$
    DECLARE registered jsonb := payload::jsonb; runtime jsonb := registered #> '{obligations,configuration}';
      policy_json json; policy jsonb; binding jsonb; engine text; expected_schema text; protocol_hash text;
    BEGIN
      IF runtime->>'schemaVersion' IS DISTINCT FROM 'bayn.qualification-runtime.v3' THEN RETURN false; END IF;
      FOR policy_json IN SELECT value FROM json_array_elements(payload->'policies') LOOP
        policy := policy_json::jsonb; binding := policy->'strategyBinding'; engine := binding->>'engine';
        expected_schema := CASE engine
          WHEN 'JEV_V44' THEN 'bayn.jev.protocol.v44'
          WHEN 'INTRADAY_ALPHA_V2' THEN 'bayn.intraday-alpha-policy.v2'
          WHEN 'ENTRY_ABLATION_V1' THEN 'bayn.entry-ablation-policy.v1'
          WHEN 'REPEATED_MOMENTUM_V1' THEN 'bayn.repeated-momentum-policy.v1'
          WHEN 'FROZEN_DEPLOYED_V3' THEN 'bayn.intraday-momentum.protocol.v3' END;
        IF NOT ((
          jsonb_typeof(binding)='object' AND binding->>'schemaVersion'='bayn.research-strategy-binding.v1'
          AND binding - ARRAY['schemaVersion','engine','parameters','strategy','protocolHash']='{}'::jsonb
          AND jsonb_typeof(binding->'parameters')='object' AND jsonb_typeof(binding->'strategy')='object'
          AND binding #>> '{parameters,schemaVersion}'=expected_schema
          AND binding #>> '{strategy,parameterSchemaVersion}'=expected_schema
          AND binding #>> '{strategy,behaviorHash}'=policy->>'strategyHash'
          AND binding #>> '{strategy,parameterHash}'=policy->>'parametersHash'
          AND binding->>'protocolHash'=policy->>'protocolHash'
          AND policy->>'parametersHash'=encode(sha256(convert_to(
            (policy_json #> '{strategyBinding,parameters}')::text,'UTF8')),'hex')
          AND ((policy->>'policy' IN ('JEV','INCUMBENT_JEV') AND engine IN ('JEV_V44','INTRADAY_ALPHA_V2'))
            OR (policy->>'policy'='JEV_ABLATION' AND engine='ENTRY_ABLATION_V1')
            OR (policy->>'policy'='REPEATED_MOMENTUM' AND engine='REPEATED_MOMENTUM_V1')
            OR (policy->>'policy'='DEPLOYED_BAYN' AND engine='FROZEN_DEPLOYED_V3'))
          AND binding #>> '{strategy,name}'=CASE WHEN engine='FROZEN_DEPLOYED_V3' THEN 'intraday-momentum' ELSE 'jev' END
        ) IS TRUE) THEN RETURN false; END IF;
        SELECT encode(sha256(convert_to('{' || string_agg(to_json(key)::text || ':' || value::text, ','
          ORDER BY key COLLATE "C") || '}', 'UTF8')),'hex') INTO protocol_hash
        FROM json_each(json_build_object(
          'schemaVersion','bayn.strategy-protocol.v1', 'name',binding #>> '{strategy,name}',
          'behaviorHash',binding #>> '{strategy,behaviorHash}', 'parameterHash',binding #>> '{strategy,parameterHash}',
          'parameterSchemaVersion',binding #>> '{strategy,parameterSchemaVersion}'));
        IF binding->>'protocolHash' IS DISTINCT FROM protocol_hash THEN RETURN false; END IF;
        IF engine<>'FROZEN_DEPLOYED_V3' AND
          (CASE WHEN engine='JEV_V44' THEN binding->'parameters' ELSE binding #> '{parameters,sharedProtocol}' END)
            IS DISTINCT FROM runtime->'protocol' THEN RETURN false; END IF;
        IF policy->>'policy'='JEV' AND runtime->'strategyBinding' IS DISTINCT FROM binding THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    END $function$`
  // Extend immutable decoding and assessment; only prospective admission moves to v6.
  yield* sql`DO $migration$
    DECLARE definition text; constraint_row record; cut_shapes integer := 0;
      prior_hash text := '3bcca8feb62f42e6f5df33cb875630e6c4c5419bfb1b71fbae68661a3f1e238b';
      current_hash text := 'ff34eef46ed69fb9e4f6398d54e00da7f3b4cee246252a1f909fae0d79e01fd8';
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
        WHERE conrelid='system_qualification_registrations'::regclass AND conname='system_registration_payload_shape';
      IF strpos(definition,'''bayn.system-registration.v5''::text')=0 THEN
        RAISE EXCEPTION 'unexpected strategy-bound registration shape predecessor'; END IF;
      EXECUTE 'ALTER TABLE system_qualification_registrations DROP CONSTRAINT system_registration_payload_shape, '
        || 'ADD CONSTRAINT system_registration_payload_shape ' || replace(definition,
          '''bayn.system-registration.v5''::text','''bayn.system-registration.v5''::text, ''bayn.system-registration.v6''::text');
      SELECT pg_get_functiondef('admit_system_qualification_registration()'::regprocedure) INTO STRICT definition;
      IF strpos(definition,prior_hash)=0 OR strpos(definition,'''bayn.system-registration.v5''')=0
        OR strpos(definition,'NEW.created_at := clock_timestamp();')=0 THEN
        RAISE EXCEPTION 'unexpected strategy-bound admission predecessor'; END IF;
      definition := replace(replace(definition,'bayn.system-registration.v5','bayn.system-registration.v6'),prior_hash,current_hash);
      EXECUTE replace(definition,'NEW.created_at := clock_timestamp();',$admission$
        IF NEW.program='BAYN_SYSTEM_QUALIFICATION'
          AND NOT system_strategy_bound_registration_valid(NEW.payload_text::json) THEN
          RAISE EXCEPTION 'registration must bind each policy to its complete engine and shared runtime'
            USING ERRCODE='23514';
        END IF;
        NEW.created_at := clock_timestamp();
      $admission$);
      SELECT pg_get_functiondef('check_system_assessment_scope()'::regprocedure) INTO STRICT definition;
      IF strpos(definition,'''bayn.system-registration.v4'',''bayn.system-registration.v5''')=0
        OR strpos(definition,'schemaVersion''=''bayn.system-registration.v5''')=0 THEN
        RAISE EXCEPTION 'unexpected strategy-bound assessment predecessor'; END IF;
      definition := replace(definition,'''bayn.system-registration.v4'',''bayn.system-registration.v5''',
        '''bayn.system-registration.v4'',''bayn.system-registration.v5'',''bayn.system-registration.v6''');
      EXECUTE replace(definition,'schemaVersion''=''bayn.system-registration.v5''',
        'schemaVersion'' IN (''bayn.system-registration.v5'',''bayn.system-registration.v6'')');
      SELECT pg_get_functiondef('capture_operational_safety_baseline()'::regprocedure) INTO STRICT definition;
      IF strpos(definition,'= ''bayn.system-registration.v5''')=0 THEN
        RAISE EXCEPTION 'unexpected qualification authority witness predecessor'; END IF;
      EXECUTE replace(definition,'= ''bayn.system-registration.v5''',
        'IN (''bayn.system-registration.v5'',''bayn.system-registration.v6'')');
      SELECT pg_get_functiondef('check_qualification_pair_seal()'::regprocedure) INTO STRICT definition;
      IF strpos(definition,'= ''bayn.system-registration.v5''')=0 THEN
        RAISE EXCEPTION 'unexpected qualification pair seal predecessor'; END IF;
      EXECUTE replace(definition,'= ''bayn.system-registration.v5''',
        'IN (''bayn.system-registration.v5'',''bayn.system-registration.v6'')');
      FOR constraint_row IN SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='system_evidence_cuts'::regclass AND contype='c'
          AND strpos(pg_get_constraintdef(oid),'''bayn.system-source-cut.v4''::text')>0 LOOP
        cut_shapes := cut_shapes + 1;
        IF strpos(constraint_row.definition,'''bayn.operational-source-cut.v1''::text')=0 THEN
          RAISE EXCEPTION 'unexpected retained operational source cut shape predecessor'; END IF;
        -- Preserve every retained branch and predicate, including operational records, before adding v5.
        definition := substring(constraint_row.definition FROM 7);
        EXECUTE format('ALTER TABLE system_evidence_cuts DROP CONSTRAINT %I, ADD CONSTRAINT %I %s',
          constraint_row.conname, constraint_row.conname,
          'CHECK (' || definition || ' OR ' || replace(definition,
            '''bayn.system-source-cut.v4''::text','''bayn.system-source-cut.v5''::text') || ')');
      END LOOP;
      IF cut_shapes<>1 THEN RAISE EXCEPTION 'unexpected strategy-bound source cut shape predecessor'; END IF;
    END $migration$`
  yield* sql`ALTER TABLE system_pending_evidence DROP CONSTRAINT system_pending_evidence_kind_check,
    ADD CONSTRAINT system_pending_evidence_kind_check
      CHECK (kind IN ('DECISION','RECONCILIATION','MUTATION','CONTROLLER','BATCH','ALPHA_OBSERVATION'))`
  yield* sql`ALTER TABLE system_durable_observations DROP CONSTRAINT system_durable_observations_kind_check,
    ADD CONSTRAINT system_durable_observations_kind_check
      CHECK (kind IN ('DECISION','RECONCILIATION','MUTATION','CONTROLLER','BATCH','ALPHA_OBSERVATION'))`
  // No backfill: a source and its pending evidence must commit together before a later controller can witness it.
  yield* sql`CREATE FUNCTION enqueue_alpha_observation_evidence() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.payload->>'schemaVersion' IS DISTINCT FROM 'bayn.intraday-alpha-observation.v2' THEN RETURN NEW; END IF;
      INSERT INTO system_pending_evidence(registration_hash,kind,source_hash,source_at,correct)
      SELECT registered.registration_hash,'ALPHA_OBSERVATION',NEW.content_hash,NEW.observed_at,true
      FROM system_qualification_registrations registered
      CROSS JOIN LATERAL jsonb_array_elements(registered.payload_text::jsonb->'policies') policy
      JOIN authority_generations generation ON generation.generation_hash=policy->>'authorityGenerationHash'
      JOIN autonomous_cycles cycle ON cycle.cycle_id=NEW.cycle_id
      WHERE registered.program='BAYN_SYSTEM_QUALIFICATION'
        AND registered.payload_text::jsonb->>'schemaVersion'='bayn.system-registration.v6'
        AND policy->>'policy'='JEV' AND policy #>> '{strategyBinding,engine}'='INTRADAY_ALPHA_V2'
        AND NEW.payload->>'authorityGenerationHash'=generation.generation_hash
        AND NEW.payload #>> '{portfolio,brokerState,account,accountId}'=generation.account_id
        AND cycle.account_id=generation.account_id AND cycle.strategy_protocol_hash=policy->>'protocolHash'
        AND NEW.payload->'protocol'=policy #> '{strategyBinding,parameters,sharedProtocol}'
        AND registered.created_at<=NEW.observed_at AND NEW.observed_at<=clock_timestamp()
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(registered.payload_text::jsonb #> '{calendar,sessions}') session
          WHERE NEW.observed_at >= (session->>'openAt')::timestamptz AND NEW.observed_at < (session->>'closeAt')::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM system_durable_observations prior
          WHERE prior.registration_hash=registered.registration_hash AND prior.kind='ALPHA_OBSERVATION'
            AND prior.source_hash=NEW.content_hash)
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER intraday_candidate_observations_system_evidence AFTER INSERT ON intraday_candidate_observations
    FOR EACH ROW EXECUTE FUNCTION enqueue_alpha_observation_evidence()`
  yield* sql`CREATE FUNCTION guard_alpha_observation_witness() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.kind<>'ALPHA_OBSERVATION' THEN RETURN NEW; END IF;
      IF pg_trigger_depth()<2 OR NOT EXISTS (
        SELECT 1 FROM system_pending_evidence pending
        JOIN intraday_candidate_observations observation ON observation.content_hash=pending.source_hash
        WHERE pending.registration_hash=NEW.registration_hash AND pending.kind=NEW.kind
          AND pending.source_hash=NEW.source_hash AND pending.source_at=NEW.source_at
          AND pending.correct=NEW.correct AND pending.correct
          AND observation.observed_at=pending.source_at AND observation.payload->>'schemaVersion'='bayn.intraday-alpha-observation.v2'
          AND system_evidence_source_committed(pending.xmin) AND system_evidence_source_committed(observation.xmin)
      ) THEN RAISE EXCEPTION 'alpha evidence requires its committed source and later controller witness' USING ERRCODE='55000'; END IF;
      NEW.witnessed_at := clock_timestamp();
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER system_durable_alpha_observation_guard BEFORE INSERT ON system_durable_observations
    FOR EACH ROW EXECUTE FUNCTION guard_alpha_observation_witness()`
  yield* sql`CREATE FUNCTION check_strategy_bound_source_cut() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE registered_version text; cut jsonb := NEW.payload_text::jsonb;
    BEGIN
      SELECT payload_text::jsonb->>'schemaVersion' INTO STRICT registered_version
        FROM system_qualification_registrations WHERE registration_hash=NEW.registration_hash;
      IF (registered_version='bayn.system-registration.v6') IS DISTINCT FROM (cut->>'schemaVersion'='bayn.system-source-cut.v5') THEN
        RAISE EXCEPTION 'source cut version differs from its immutable registration' USING ERRCODE='23514'; END IF;
      IF registered_version<>'bayn.system-registration.v6' THEN RETURN NEW; END IF;
      IF jsonb_typeof(cut->'alphaObservations') IS DISTINCT FROM 'array'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(cut->'alphaObservations') supplied
          WHERE NOT EXISTS (SELECT 1 FROM intraday_candidate_observations retained
            WHERE retained.content_hash=supplied->>'contentHash' AND retained.payload=supplied->'payload'))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(cut->'durableObservations') supplied
          WHERE supplied->>'kind'='ALPHA_OBSERVATION' AND NOT EXISTS (
            SELECT 1 FROM system_durable_observations retained
            WHERE retained.registration_hash=NEW.registration_hash AND retained.kind='ALPHA_OBSERVATION'
              AND retained.source_hash=supplied->>'sourceHash'
              AND retained.source_at=(supplied->>'sourceAt')::timestamptz
              AND (date_trunc('milliseconds',retained.witnessed_at)
                + CASE WHEN retained.witnessed_at>date_trunc('milliseconds',retained.witnessed_at)
                  THEN interval '1 millisecond' ELSE interval '0' END)=(supplied->>'witnessedAt')::timestamptz
              AND retained.correct=(supplied->>'correct')::boolean AND retained.witnessed_at<=NEW.as_of)) THEN
        RAISE EXCEPTION 'alpha source cut differs from its retained observation or committed witness' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER strategy_bound_source_cut_scope BEFORE INSERT ON system_evidence_cuts
    FOR EACH ROW EXECUTE FUNCTION check_strategy_bound_source_cut()`
})
