import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DO $migration$
  DECLARE definition text; constraint_name text; guard regprocedure;
  BEGIN
    FOREACH constraint_name IN ARRAY ARRAY[
      'authority_generations_strategy_parameter_schema_version_check',
      'authority_generations_strategy_contract_check'
    ] LOOP
      SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
        WHERE conrelid = 'authority_generations'::regclass AND conname = constraint_name;
      IF strpos(definition, '''bayn.jev.protocol.v35''') = 0 THEN
        RAISE EXCEPTION 'unexpected prior authority protocol constraint' USING ERRCODE = '55000';
      END IF;
      EXECUTE format('ALTER TABLE authority_generations DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',
        constraint_name, constraint_name,
        replace(replace(definition, ' NOT VALID', ''), '''bayn.jev.protocol.v35''', '''bayn.jev.protocol.v35'', ''bayn.jev.protocol.v36'''));
    END LOOP;
    SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
      WHERE conrelid = 'jev_evaluation_requests'::regclass AND conname = 'jev_evaluation_requests_check';
    IF strpos(definition, '''bayn.jev.protocol.v35''') = 0 THEN
      RAISE EXCEPTION 'unexpected prior entry protocol constraint' USING ERRCODE = '55000';
    END IF;
    EXECUTE 'ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check, ADD CONSTRAINT jev_evaluation_requests_check '
      || replace(replace(definition, ' NOT VALID', ''), '''bayn.jev.protocol.v35''', '''bayn.jev.protocol.v36''') || ' NOT VALID';
    FOREACH guard IN ARRAY ARRAY['enforce_staged_dispatch_claim()'::regprocedure, 'enforce_staged_skip_receipt()'::regprocedure] LOOP
      definition := pg_get_functiondef(guard);
      IF strpos(definition, '''bayn.jev.protocol.v35''') = 0 THEN
        RAISE EXCEPTION 'unexpected prior staged dispatch protocol' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(definition, '''bayn.jev.protocol.v35''', '''bayn.jev.protocol.v36''');
    END LOOP;
    definition := pg_get_functiondef('enforce_inference_expense_stage()'::regprocedure);
    definition := replace(definition, '= ''bayn.jev.protocol.v35''', 'IN (''bayn.jev.protocol.v35'', ''bayn.jev.protocol.v36'')');
    EXECUTE replace(definition, '''bayn.jev.protocol.v34'', ''bayn.jev.protocol.v35'')', '''bayn.jev.protocol.v34'', ''bayn.jev.protocol.v35'', ''bayn.jev.protocol.v36'')');
  END $migration$`
  // Retain already-paid v35 outcomes. Only v36 may admit a new request or provider dispatch.
  yield* sql`CREATE OR REPLACE FUNCTION enforce_current_entry_protocol() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb;
    BEGIN
      SELECT payload INTO STRICT source FROM jev_evaluation_requests WHERE request_id = NEW.request_id FOR UPDATE;
      IF (source #>> '{request,protocol,schemaVersion}') IS NULL
        OR source #>> '{request,protocol,schemaVersion}' NOT IN ('bayn.jev.protocol.v35', 'bayn.jev.protocol.v36') THEN
        RAISE EXCEPTION 'retired entry protocol cannot create inference evidence' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $function$`
})
