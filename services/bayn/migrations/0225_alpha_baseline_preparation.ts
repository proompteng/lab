import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Keep all historical decoders and receipt predicates; only prospective admission moves forward.
  yield* sql`DO $migration$
    DECLARE definition text; constraint_row record; guard regprocedure; cut_shapes integer := 0;
      prior_hash text := 'ff34eef46ed69fb9e4f6398d54e00da7f3b4cee246252a1f909fae0d79e01fd8';
      current_hash text := 'c71d9a6a249bbd7175adc7d75e604d50bb80a001f27d1c07275833c2194ecdfe';
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
        WHERE conrelid='system_qualification_registrations'::regclass AND conname='system_registration_payload_shape';
      IF strpos(definition,'''bayn.system-registration.v6''::text')=0 THEN
        RAISE EXCEPTION 'unexpected prepared-baseline registration predecessor'; END IF;
      EXECUTE 'ALTER TABLE system_qualification_registrations DROP CONSTRAINT system_registration_payload_shape, '
        || 'ADD CONSTRAINT system_registration_payload_shape ' || replace(definition,
          '''bayn.system-registration.v6''::text','''bayn.system-registration.v6''::text, ''bayn.system-registration.v7''::text');
      SELECT pg_get_functiondef('admit_system_qualification_registration()'::regprocedure) INTO STRICT definition;
      IF strpos(definition,prior_hash)=0 OR strpos(definition,'''bayn.system-registration.v6''')=0 THEN
        RAISE EXCEPTION 'unexpected prepared-baseline admission predecessor'; END IF;
      EXECUTE replace(replace(definition,'bayn.system-registration.v6','bayn.system-registration.v7'),prior_hash,current_hash);
      FOREACH guard IN ARRAY ARRAY['check_system_assessment_scope()'::regprocedure,
        'capture_operational_safety_baseline()'::regprocedure,'check_qualification_pair_seal()'::regprocedure] LOOP
        SELECT pg_get_functiondef(guard) INTO STRICT definition;
        IF strpos(definition,'''bayn.system-registration.v6''')=0 THEN
          RAISE EXCEPTION 'unexpected native prepared-baseline scope predecessor'; END IF;
        EXECUTE replace(definition,'''bayn.system-registration.v6''','''bayn.system-registration.v6'',''bayn.system-registration.v7''');
      END LOOP;
      FOR constraint_row IN SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='system_evidence_cuts'::regclass AND contype='c'
          AND strpos(pg_get_constraintdef(oid),'''bayn.system-source-cut.v5''::text')>0 LOOP
        cut_shapes := cut_shapes+1;
        IF strpos(constraint_row.definition,'''bayn.operational-source-cut.v1''::text')=0 THEN
          RAISE EXCEPTION 'unexpected operational source-cut predecessor'; END IF;
        definition := substring(constraint_row.definition FROM 7);
        EXECUTE format('ALTER TABLE system_evidence_cuts DROP CONSTRAINT %I, ADD CONSTRAINT %I %s',
          constraint_row.conname,constraint_row.conname,'CHECK (' || definition || ' OR ' || replace(definition,
            '''bayn.system-source-cut.v5''::text','''bayn.system-source-cut.v6''::text') || ')');
      END LOOP;
      IF cut_shapes<>1 THEN RAISE EXCEPTION 'unexpected prepared-baseline source-cut shape predecessor'; END IF;
      SELECT pg_get_functiondef('enqueue_alpha_observation_evidence()'::regprocedure) INTO STRICT definition;
      IF strpos(definition,'=''bayn.system-registration.v6''')=0 THEN
        RAISE EXCEPTION 'unexpected alpha observation registration predecessor'; END IF;
      EXECUTE replace(definition,'=''bayn.system-registration.v6''',' IN (''bayn.system-registration.v6'',''bayn.system-registration.v7'')');
      SELECT pg_get_functiondef('check_strategy_bound_source_cut()'::regprocedure) INTO STRICT definition;
      IF strpos(definition,'IF (registered_version=''bayn.system-registration.v6'') IS DISTINCT FROM (cut->>''schemaVersion''=''bayn.system-source-cut.v5'') THEN')=0
        OR strpos(definition,'IF registered_version<>''bayn.system-registration.v6'' THEN RETURN NEW; END IF;')=0 THEN
        RAISE EXCEPTION 'unexpected strategy-bound source-cut scope predecessor'; END IF;
      definition := replace(definition,
        'IF (registered_version=''bayn.system-registration.v6'') IS DISTINCT FROM (cut->>''schemaVersion''=''bayn.system-source-cut.v5'') THEN',
        'IF ((registered_version=''bayn.system-registration.v6'') IS DISTINCT FROM (cut->>''schemaVersion''=''bayn.system-source-cut.v5'')) OR ((registered_version=''bayn.system-registration.v7'') IS DISTINCT FROM (cut->>''schemaVersion''=''bayn.system-source-cut.v6'')) THEN');
      EXECUTE replace(definition,'IF registered_version<>''bayn.system-registration.v6'' THEN RETURN NEW; END IF;',
        'IF registered_version NOT IN (''bayn.system-registration.v6'',''bayn.system-registration.v7'') THEN RETURN NEW; END IF;');
    END $migration$`

  yield* sql`CREATE TABLE intraday_alpha_baseline_preparations (
    content_hash text PRIMARY KEY CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    scope_hash text NOT NULL UNIQUE CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
    scope_text text NOT NULL,
    cycle_id text NOT NULL REFERENCES autonomous_cycles(cycle_id),
    authority_generation_hash text NOT NULL REFERENCES authority_generations(generation_hash),
    account_id text NOT NULL CHECK (account_id<>''),
    session_date date NOT NULL,
    payload_text text NOT NULL,
    payload jsonb GENERATED ALWAYS AS (payload_text::jsonb) STORED,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (content_hash=encode(sha256(convert_to(payload_text,'UTF8')),'hex')),
    CHECK (scope_hash=encode(sha256(convert_to(scope_text,'UTF8')),'hex')),
    CHECK ((jsonb_typeof(payload)='object'
      AND payload->>'schemaVersion'='bayn.intraday-alpha-baseline-preparation.v1'
      AND payload->>'cycleId'=cycle_id AND payload->>'authorityGenerationHash'=authority_generation_hash
      AND payload->>'accountId'=account_id AND (payload->>'sessionDate')::date=session_date
      AND payload #>> '{policy,schemaVersion}'='bayn.intraday-alpha-policy.v2'
      AND payload #>> '{acquisition,schemaVersion}'='bayn.intraday-alpha-baseline-acquisition.v1'
      AND payload #>> '{acquisition,query,sessionDate}'=payload->>'sessionDate'
      AND payload #>> '{acquisition,trailingBaseline,sessionDate}'=payload->>'sessionDate'
      AND (payload #>> '{acquisition,trailingBaseline,latestPriorSessionDate}')::date<session_date
      AND payload #>> '{acquisition,query,sourceContract,provider}'='alpaca'
      AND payload #>> '{acquisition,query,sourceContract,feed}'='iex'
      AND payload #>> '{executionBuild,sourceRevision}' ~ '^[0-9a-f]{40}$'
      AND payload #>> '{executionBuild,imageDigest}' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(payload #> '{executionBuild,imageRepository}')='string'
      AND (payload #>> '{acquisition,startedAt}')::timestamptz <= (payload #>> '{acquisition,completedAt}')::timestamptz
      AND (payload #>> '{acquisition,completedAt}')::timestamptz <= recorded_at) IS TRUE),
    CHECK ((scope_text::jsonb->>'schemaVersion'='bayn.intraday-alpha-baseline-preparation-scope.v1'
      AND scope_text::jsonb->>'accountId'=account_id
      AND scope_text::jsonb->>'authorityGenerationHash'=authority_generation_hash
      AND scope_text::jsonb->>'sessionDate'=payload->>'sessionDate'
      AND scope_text::jsonb->'policy'=payload->'policy'
      AND scope_text::jsonb->'executionBuild'=payload->'executionBuild'
      AND scope_text::jsonb->'query'=payload #> '{acquisition,query}') IS TRUE)
  )`
  yield* sql`CREATE INDEX intraday_alpha_baseline_preparations_capture
    ON intraday_alpha_baseline_preparations(account_id,authority_generation_hash,session_date,recorded_at,content_hash)`
  yield* sql`CREATE FUNCTION guard_alpha_baseline_preparation() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb := NEW.payload_text::jsonb; scope jsonb := NEW.scope_text::jsonb;
      actual timestamptz := clock_timestamp(); parameters_hash text;
    BEGIN
      NEW.recorded_at := date_trunc('milliseconds',actual)
        + CASE WHEN actual>date_trunc('milliseconds',actual) THEN interval '1 millisecond' ELSE interval '0' END;
      parameters_hash := encode(sha256(convert_to((NEW.payload_text::json->'policy')::text,'UTF8')),'hex');
      IF NOT EXISTS (
        SELECT 1 FROM autonomous_cycles cycle JOIN authority_generations generation ON generation.generation_hash=NEW.authority_generation_hash
        WHERE cycle.cycle_id=NEW.cycle_id AND cycle.account_id=NEW.account_id AND cycle.strategy_name='jev'
          AND cycle.qualification_run_id=COALESCE(generation.qualification_run_id,generation.research_plan_hash,generation.generation_hash)
          AND cycle.execution_session_date=NEW.session_date
          AND (generation.account_id IS NULL OR generation.account_id=NEW.account_id)
          AND (generation.strategy_parameter_hash IS NULL OR generation.strategy_parameter_hash=parameters_hash)
          AND (generation.strategy_protocol_hash IS NULL OR generation.strategy_protocol_hash=cycle.strategy_protocol_hash)
          AND cycle.execution_open_at=(scope #>> '{nativeSession,openAt}')::timestamptz
          AND cycle.execution_close_at=(scope #>> '{nativeSession,closeAt}')::timestamptz
          AND (source #>> '{acquisition,startedAt}')::timestamptz>=cycle.execution_open_at
          AND NEW.recorded_at<cycle.execution_close_at
      ) OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(source #> '{calendar,sessions}') session
        WHERE session=scope->'nativeSession' AND (session->>'date')::date=NEW.session_date)
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(source #> '{calendar,providerSessions}') session
        WHERE session=scope->'providerSession' AND (session->>'date')::date=NEW.session_date) THEN
        RAISE EXCEPTION 'prepared baseline differs from its native cycle, authority or calendar' USING ERRCODE='23514';
      END IF;
      IF (source #>> '{acquisition,startedAt}')::timestamptz < (scope #>> '{providerSession,regularOpenAt}')::timestamptz
        AND (EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(source #> '{acquisition,query,symbols}') requested(symbol)
          WHERE NOT coalesce(
            (source #>> ARRAY['acquisition','trailingBaseline','symbols',requested.symbol,'priorSessions'])::numeric
              >= (source #>> '{acquisition,query,minimumSessions}')::numeric
            AND (source #>> ARRAY['acquisition','trailingBaseline','symbols',requested.symbol,'prevClose'])::numeric > 0
            AND (source #>> ARRAY['acquisition','trailingBaseline','symbols',requested.symbol,'atr14Ratio'])::numeric > 0
            AND (source #>> ARRAY['acquisition','trailingBaseline','symbols',requested.symbol,'atr14Ratio'])::numeric <= 0.5, false)
        ) OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(source #> '{acquisition,query,noiseAreaSymbols}') requested(symbol)
            CROSS JOIN jsonb_array_elements_text(source #> '{policy,noiseArea,checkpointMinutesFromOpen}') checkpoint(minute)
          WHERE NOT coalesce(
            (source #>> ARRAY['acquisition','trailingBaseline','symbols',requested.symbol,'avgSwingByCheckpoint',checkpoint.minute])::numeric > 0
            AND (source #>> ARRAY['acquisition','trailingBaseline','symbols',requested.symbol,'avgSwingByCheckpoint',checkpoint.minute])::numeric <= 0.5, false)
        )) THEN
        RAISE EXCEPTION 'preopen baseline preparation requires complete symbol and noise-checkpoint coverage' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER alpha_baseline_preparation_scope BEFORE INSERT ON intraday_alpha_baseline_preparations
    FOR EACH ROW EXECUTE FUNCTION guard_alpha_baseline_preparation()`
  yield* sql`CREATE TRIGGER alpha_baseline_preparations_immutable BEFORE UPDATE OR DELETE ON intraday_alpha_baseline_preparations
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER alpha_baseline_preparations_no_truncate BEFORE TRUNCATE ON intraday_alpha_baseline_preparations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`ALTER TABLE system_pending_evidence DROP CONSTRAINT system_pending_evidence_kind_check,
    ADD CONSTRAINT system_pending_evidence_kind_check
      CHECK (kind IN ('DECISION','RECONCILIATION','MUTATION','CONTROLLER','BATCH','ALPHA_OBSERVATION','ALPHA_BASELINE'))`
  yield* sql`ALTER TABLE system_durable_observations DROP CONSTRAINT system_durable_observations_kind_check,
    ADD CONSTRAINT system_durable_observations_kind_check
      CHECK (kind IN ('DECISION','RECONCILIATION','MUTATION','CONTROLLER','BATCH','ALPHA_OBSERVATION','ALPHA_BASELINE'))`
  yield* sql`CREATE FUNCTION enqueue_alpha_baseline_evidence() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      INSERT INTO system_pending_evidence(registration_hash,kind,source_hash,source_at,correct)
      SELECT registered.registration_hash,'ALPHA_BASELINE',NEW.content_hash,NEW.recorded_at,true
      FROM system_qualification_registrations registered
      CROSS JOIN LATERAL jsonb_array_elements(registered.payload_text::jsonb->'policies') policy
      JOIN authority_generations generation ON generation.generation_hash=policy->>'authorityGenerationHash'
      WHERE registered.program='BAYN_SYSTEM_QUALIFICATION'
        AND registered.payload_text::jsonb->>'schemaVersion'='bayn.system-registration.v7'
        AND policy->>'policy'='JEV' AND policy #>> '{strategyBinding,engine}'='INTRADAY_ALPHA_V2'
        AND NEW.authority_generation_hash=generation.generation_hash AND NEW.account_id=generation.account_id
        AND NEW.payload->'policy'=policy #> '{strategyBinding,parameters}'
        AND NEW.payload #>> '{executionBuild,sourceRevision}'=policy->>'sourceRevision'
        AND NEW.payload #>> '{executionBuild,imageDigest}'='sha256:' || (policy->>'imageDigest')
        AND (policy #>> '{capitalAuthorization,buildLineage,activation,imageRepository}' IS NULL
          OR NEW.payload #>> '{executionBuild,imageRepository}'=policy #>> '{capitalAuthorization,buildLineage,activation,imageRepository}')
        AND registered.created_at <= (NEW.payload #>> '{acquisition,startedAt}')::timestamptz
        AND system_evidence_source_committed(registered.xmin)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(registered.payload_text::jsonb #> '{calendar,sessions}') session
          WHERE (session->>'sessionDate')::date=NEW.session_date
            AND NEW.recorded_at >= (session->>'openAt')::timestamptz AND NEW.recorded_at < (session->>'closeAt')::timestamptz
            AND NEW.scope_text::jsonb #>> '{nativeSession,openAt}'=session->>'openAt'
            AND NEW.scope_text::jsonb #>> '{nativeSession,closeAt}'=session->>'closeAt')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(registered.payload_text::jsonb #> '{calendar,marketCalendar,providerSessions}') session
          WHERE session=NEW.scope_text::jsonb->'providerSession')
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER alpha_baseline_preparations_system_evidence AFTER INSERT ON intraday_alpha_baseline_preparations
    FOR EACH ROW EXECUTE FUNCTION enqueue_alpha_baseline_evidence()`
  yield* sql`CREATE FUNCTION guard_alpha_baseline_witness() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.kind<>'ALPHA_BASELINE' THEN RETURN NEW; END IF;
      IF pg_trigger_depth()<2 OR NOT EXISTS (
        SELECT 1 FROM system_pending_evidence pending
        JOIN intraday_alpha_baseline_preparations source ON source.content_hash=pending.source_hash
        WHERE pending.registration_hash=NEW.registration_hash AND pending.kind=NEW.kind
          AND pending.source_hash=NEW.source_hash AND pending.source_at=NEW.source_at
          AND pending.correct=NEW.correct AND pending.correct AND source.recorded_at=pending.source_at
          AND system_evidence_source_committed(pending.xmin) AND system_evidence_source_committed(source.xmin)
      ) THEN RAISE EXCEPTION 'baseline evidence requires its committed source and later controller witness' USING ERRCODE='55000'; END IF;
      NEW.witnessed_at := clock_timestamp();
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER system_durable_alpha_baseline_guard BEFORE INSERT ON system_durable_observations
    FOR EACH ROW EXECUTE FUNCTION guard_alpha_baseline_witness()`
  yield* sql`CREATE FUNCTION check_prepared_alpha_source_cut() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE registered_version text; cut jsonb := NEW.payload_text::jsonb;
    BEGIN
      SELECT payload_text::jsonb->>'schemaVersion' INTO STRICT registered_version
        FROM system_qualification_registrations WHERE registration_hash=NEW.registration_hash;
      IF registered_version<>'bayn.system-registration.v7' THEN RETURN NEW; END IF;
      IF jsonb_typeof(cut->'alphaBaselinePreparations') IS DISTINCT FROM 'array'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(cut->'alphaBaselinePreparations') supplied
          WHERE NOT EXISTS (SELECT 1 FROM intraday_alpha_baseline_preparations retained
            WHERE retained.content_hash=supplied->>'contentHash' AND retained.payload=supplied->'payload'
              AND retained.recorded_at=(supplied->>'recordedAt')::timestamptz AND retained.recorded_at<=NEW.as_of))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(cut->'durableObservations') supplied
          WHERE supplied->>'kind'='ALPHA_BASELINE' AND NOT EXISTS (
            SELECT 1 FROM system_durable_observations retained
            WHERE retained.registration_hash=NEW.registration_hash AND retained.kind='ALPHA_BASELINE'
              AND retained.source_hash=supplied->>'sourceHash' AND retained.source_at=(supplied->>'sourceAt')::timestamptz
              AND (date_trunc('milliseconds',retained.witnessed_at)
                + CASE WHEN retained.witnessed_at>date_trunc('milliseconds',retained.witnessed_at) THEN interval '1 millisecond' ELSE interval '0' END)=(supplied->>'witnessedAt')::timestamptz
              AND retained.correct=(supplied->>'correct')::boolean AND retained.witnessed_at<=NEW.as_of)) THEN
        RAISE EXCEPTION 'prepared baseline cut differs from its retained source or committed witness' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER prepared_alpha_source_cut_scope BEFORE INSERT ON system_evidence_cuts
    FOR EACH ROW EXECUTE FUNCTION check_prepared_alpha_source_cut()`
})
