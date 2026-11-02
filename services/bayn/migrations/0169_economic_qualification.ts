import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE system_qualification_registrations
    DROP CONSTRAINT system_registration_payload_shape,
    ADD CONSTRAINT system_registration_payload_shape CHECK ((jsonb_typeof(payload_text::jsonb) = 'object'
      AND payload_text::jsonb->>'schemaVersion' IN ('bayn.system-registration.v2', 'bayn.system-registration.v3')
      AND jsonb_typeof(payload_text::jsonb->'costAllocationPlans') IS NOT DISTINCT FROM 'array'
      AND payload_text::jsonb->>'environment' IS NOT DISTINCT FROM 'PAPER'
      AND payload_text::jsonb->>'program' IS NOT DISTINCT FROM program
      AND (payload_text::jsonb->>'attemptIndex')::integer IS NOT DISTINCT FROM attempt_index
      AND payload_text::jsonb->>'priorAttemptHash' IS NOT DISTINCT FROM prior_attempt_hash
      AND (payload_text::jsonb->>'registeredAt')::timestamptz IS NOT DISTINCT FROM registered_at
      AND (payload_text::jsonb #>> '{calendar,sessions,0,openAt}')::timestamptz IS NOT DISTINCT FROM first_open_at
      AND (payload_text::jsonb #>> '{calendar,sessions,-1,closeAt}')::timestamptz IS NOT DISTINCT FROM last_close_at
      AND jsonb_array_length(payload_text::jsonb #> '{calendar,sessions}') > 0
      AND jsonb_array_length(payload_text::jsonb->'policies') BETWEEN 2 AND 4
      AND (payload_text::jsonb->>'schemaVersion' = 'bayn.system-registration.v2' OR (
        jsonb_typeof(payload_text::jsonb->'allocationMicros') = 'string'
        AND payload_text::jsonb->>'allocationMicros' ~ '^[1-9][0-9]*$'
        AND (payload_text::jsonb->>'allocationMicros')::numeric > 0
        AND jsonb_typeof(payload_text::jsonb->'bootstrap') = 'object'
        AND jsonb_typeof(payload_text::jsonb #> '{bootstrap,blockLengthSessions}') = 'number'
        AND jsonb_typeof(payload_text::jsonb #> '{bootstrap,replicates}') = 'number'
        AND jsonb_typeof(payload_text::jsonb #> '{bootstrap,seed}') = 'number'
        AND trunc((payload_text::jsonb #>> '{bootstrap,blockLengthSessions}')::numeric) = (payload_text::jsonb #>> '{bootstrap,blockLengthSessions}')::numeric
        AND trunc((payload_text::jsonb #>> '{bootstrap,replicates}')::numeric) = (payload_text::jsonb #>> '{bootstrap,replicates}')::numeric
        AND trunc((payload_text::jsonb #>> '{bootstrap,seed}')::numeric) = (payload_text::jsonb #>> '{bootstrap,seed}')::numeric
        AND (payload_text::jsonb #>> '{bootstrap,blockLengthSessions}')::numeric BETWEEN 1 AND jsonb_array_length(payload_text::jsonb #> '{calendar,sessions}')
        AND (payload_text::jsonb #>> '{bootstrap,seed}')::numeric BETWEEN 1 AND 4294967295
        AND (payload_text::jsonb #>> '{bootstrap,replicates}')::numeric BETWEEN
          20::numeric * jsonb_array_length(payload_text::jsonb->'policies') * attempt_index * (attempt_index::numeric + 1)
          AND 9007199254740991))) IS TRUE)`
  yield* sql`CREATE OR REPLACE FUNCTION admit_system_qualification_registration() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE prior_index integer; prior_hash text; deployed_count integer; deployed_matches boolean; risk_bounded boolean;
  BEGIN
    IF NEW.payload_text::jsonb->>'schemaVersion' IS DISTINCT FROM 'bayn.system-registration.v3' THEN
      RAISE EXCEPTION 'new registration requires the current assessment schema' USING ERRCODE = '23514';
    END IF;
    IF NEW.payload_text::jsonb->>'policyHash' IS DISTINCT FROM '7013c86f0b60da5ccc98cc82e4c9b077c8ab7a5c242f846a598bb77058782635'
      OR NEW.payload_text::jsonb->>'acceptanceProtocolHash' IS DISTINCT FROM '4db1624574c2175dfa6d279d4fed16e760e0e00ce5a7504bc9fe49c13caaf7a1' THEN
      RAISE EXCEPTION 'new registration requires the current policy identities' USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(DISTINCT policy->>'policy') FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') policy)
        <> jsonb_array_length(NEW.payload_text::jsonb->'policies')
      OR (SELECT count(*) FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') policy WHERE policy->>'policy' = 'JEV') <> 1 THEN
      RAISE EXCEPTION 'registration requires one candidate and distinct registered controls' USING ERRCODE = '23514';
    END IF;
    SELECT bool_and((
      jsonb_typeof(policy->'riskPolicy') = 'object'
      AND policy->>'policy' IN ('JEV','DEPLOYED_BAYN','REPEATED_MOMENTUM','JEV_ABLATION')
      AND policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v4'
      AND (policy #>> '{riskPolicy,maxOrderNotionalMicros}')::numeric BETWEEN 0 AND 40000000000
      AND (policy #>> '{riskPolicy,maxSymbolExposureMicros}')::numeric BETWEEN 0 AND 40000000000
      AND (policy #>> '{riskPolicy,maxGrossExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxNetExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric BETWEEN 0 AND 1000000000000
      AND (policy #>> '{riskPolicy,maxDailyLossMicros}')::numeric BETWEEN 0 AND 5000000000
      AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric BETWEEN 0 AND 10000000000
      AND (((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 200000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 5000000000)
        OR ((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 1000000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 10000000000))
      AND (NEW.payload_text::jsonb->>'allocationMicros')::numeric BETWEEN 1 AND (policy #>> '{riskPolicy,maxGrossExposureMicros}')::numeric
    ) IS TRUE) INTO risk_bounded FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') policy;
    IF risk_bounded IS NOT TRUE THEN
      RAISE EXCEPTION 'registered risk exceeds the source-approved execution ceilings or lacks material' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), bool_and(
      policy->>'strategyHash' IS NOT DISTINCT FROM '3da39b009a0cb2052b007ae9ba51f448c16b69281a37cf5ffe122314f1d801af'
      AND policy->>'parametersHash' IS NOT DISTINCT FROM 'cd004b8b43e50dde70ba70fb43deff19c5c65d60f4455e84a2e8df9991c0335f'
      AND policy->>'protocolHash' IS NOT DISTINCT FROM 'f38c7d47dc0b8eedb13da1ae7e29faa3da2ce8983fee05f4a2c89dc0ec59eb97'
    ) INTO deployed_count, deployed_matches
      FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') policy
      WHERE policy->>'policy' = 'DEPLOYED_BAYN';
    IF deployed_count > 1 OR (deployed_count = 1 AND deployed_matches IS NOT TRUE) THEN
      RAISE EXCEPTION 'deployed control must preserve the frozen pre-Jev identity' USING ERRCODE = '23514';
    END IF;
    SELECT prior_attempt_count, prior_attempt_hash INTO STRICT prior_index, prior_hash
      FROM system_qualification_origin WHERE program = NEW.program FOR UPDATE;
    SELECT attempt_index, registration_hash INTO prior_index, prior_hash
      FROM system_qualification_registrations WHERE program = NEW.program ORDER BY attempt_index DESC LIMIT 1;
    IF NOT FOUND THEN
      SELECT prior_attempt_count, prior_attempt_hash INTO STRICT prior_index, prior_hash
        FROM system_qualification_origin WHERE program = NEW.program;
    END IF;
    IF NEW.attempt_index <> prior_index + 1 OR NEW.prior_attempt_hash <> prior_hash THEN
      RAISE EXCEPTION 'qualification attempt must extend the immutable history' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := clock_timestamp();
    IF NEW.registered_at > NEW.created_at OR NEW.first_open_at <= NEW.created_at THEN
      RAISE EXCEPTION 'qualification must be registered before its first open' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE OR REPLACE FUNCTION check_frozen_control_material() RETURNS trigger LANGUAGE plpgsql AS $function$
  DECLARE matches boolean;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') policy WHERE policy->>'policy' = 'DEPLOYED_BAYN') THEN RETURN NEW; END IF;
    SELECT bool_and(
      policy->>'executionModelHash' IS NOT DISTINCT FROM 'b7fed391f5dc25a41a257de470c96c337715477f1032c1d5d802020b35144b68'
      AND policy->>'promptsHash' IS NOT DISTINCT FROM '2efd63f39ac6d6d16008b63bb5924c9925b1d7eb0b56e3aa6d07c313a5a998e6'
      AND policy->>'continuationAndExitsHash' IS NOT DISTINCT FROM '861f6179c7ce96d3b7aa8f6f45e34d67612da42c92ae639edcceb2f2ca9e48c3'
    ) INTO matches FROM jsonb_array_elements(NEW.payload_text::jsonb->'policies') policy
      WHERE policy->>'policy' = 'DEPLOYED_BAYN';
    IF matches IS NOT TRUE THEN
      RAISE EXCEPTION 'deployed control must retain its original execution, prompts and continuation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $function$`
})
