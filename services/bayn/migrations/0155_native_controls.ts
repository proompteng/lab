import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE authority_generations
    DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
    DROP CONSTRAINT authority_generations_strategy_contract_check,
    ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
      strategy_parameter_schema_version IN ('bayn.jev.protocol.v26', 'bayn.entry-ablation-policy.v1', 'bayn.repeated-momentum-policy.v1')
    ) NOT VALID,
    ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
      ((maximum = 'OBSERVE' AND strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
        OR (maximum = 'PAPER' AND strategy_name = 'jev' AND strategy_parameter_schema_version IN (
          'bayn.jev.protocol.v26', 'bayn.entry-ablation-policy.v1', 'bayn.repeated-momentum-policy.v1')))
      IS TRUE
    ) NOT VALID`
  yield* sql`ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check,
    ADD CONSTRAINT jev_evaluation_requests_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-request.v3'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
      AND (payload #>> '{request,schemaVersion}' IN ('bayn.entry-inference-input.v5', 'bayn.entry-ablation-input.v1')) IS TRUE
      AND payload #>> '{request,protocol,schemaVersion}' IS NOT DISTINCT FROM 'bayn.jev.protocol.v26'
      AND payload #>> '{request,protocol,entryQuestionPolicyHash}' IS NOT DISTINCT FROM '05b4cc847d516888abecf982abd8ca6207f62f8f642bd2381c44a9051717a305'
    ) NOT VALID`
  yield* sql`ALTER TABLE jev_batch_plans DROP CONSTRAINT jev_batch_plans_check,
    ADD CONSTRAINT jev_batch_plans_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND (payload->>'schemaVersion' IN ('bayn.jev-batch-plan.v7', 'bayn.entry-ablation-batch.v1')) IS TRUE
      AND payload->>'batchId' IS NOT DISTINCT FROM batch_id
      AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
      AND payload->>'observationHash' IS NOT DISTINCT FROM observation_hash
    ) NOT VALID`
  yield* sql`CREATE FUNCTION enforce_entry_policy_identity() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE ablation boolean; declared text; protocol text;
    BEGIN
      ablation := CASE TG_TABLE_NAME WHEN 'jev_batch_plans' THEN
        NEW.payload->>'schemaVersion' = 'bayn.entry-ablation-batch.v1'
        ELSE NEW.payload #>> '{request,schemaVersion}' = 'bayn.entry-ablation-input.v1' END;
      SELECT generation.strategy_parameter_schema_version, cycle.strategy_protocol_hash INTO declared, protocol
        FROM authority_generations generation JOIN autonomous_cycles cycle ON cycle.cycle_id = NEW.cycle_id
        WHERE generation.generation_hash = NEW.authority_generation_hash;
      IF declared = 'bayn.repeated-momentum-policy.v1'
        OR ablation IS DISTINCT FROM (declared IS NOT DISTINCT FROM 'bayn.entry-ablation-policy.v1')
        OR (ablation AND NOT EXISTS (
          SELECT 1 FROM authority_generations generation JOIN autonomous_cycles cycle ON cycle.cycle_id = NEW.cycle_id
          WHERE generation.generation_hash = NEW.authority_generation_hash
            AND generation.strategy_name = 'jev' AND cycle.strategy_name = 'jev'
            AND generation.strategy_protocol_hash = protocol
            AND generation.account_id = cycle.account_id
        )) THEN RAISE EXCEPTION 'entry policy differs from its cycle and authority identity' USING ERRCODE = '23514'; END IF;
      IF TG_TABLE_NAME = 'jev_evaluation_requests' AND ablation AND (
        NEW.payload #>> '{request,selectionPolicy}' IS DISTINCT FROM 'LOWEST_MODELED_LOSS_THEN_SOURCE_ID'
        OR NOT EXISTS (
          SELECT 1 FROM jev_batch_plans batch, jsonb_array_elements(batch.payload->'candidates') candidate
          WHERE batch.cycle_id = NEW.cycle_id AND batch.authority_generation_hash = NEW.authority_generation_hash
            AND batch.payload->>'schemaVersion' = 'bayn.entry-ablation-batch.v1'
            AND candidate->>'status' = 'REQUESTED' AND candidate->'request' = NEW.payload
        )
      ) THEN RAISE EXCEPTION 'ablation request lacks its exact committed batch policy' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END $function$`
  for (const table of ['jev_batch_plans', 'jev_evaluation_requests'])
    yield* sql.unsafe(`CREATE TRIGGER ${table}_entry_policy BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION enforce_entry_policy_identity()`)
  yield* sql`DO $handoff$ DECLARE definition text; BEGIN
    definition := pg_get_functiondef('enforce_entry_inference_handoff()'::regprocedure);
    IF position('source #>> ''{request,schemaVersion}''=''bayn.entry-inference-input.v5''' in definition) = 0 THEN
      RAISE EXCEPTION 'expected the current handoff source guard' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition,
      'source #>> ''{request,schemaVersion}''=''bayn.entry-inference-input.v5''',
      'source #>> ''{request,schemaVersion}'' IN (''bayn.entry-inference-input.v5'', ''bayn.entry-ablation-input.v1'')');
  END $handoff$`
  yield* sql`DO $chart$ DECLARE definition text; guard regprocedure; BEGIN
    FOREACH guard IN ARRAY ARRAY['enforce_staged_dispatch_claim()'::regprocedure, 'enforce_staged_skip_receipt()'::regprocedure] LOOP
    definition := pg_get_functiondef(guard);
    IF position('source #>> ''{request,schemaVersion}'' IS DISTINCT FROM ''bayn.entry-inference-input.v5''' in definition) = 0 THEN
      RAISE EXCEPTION 'expected the current chart dispatch source guard' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition,
      'source #>> ''{request,schemaVersion}'' IS DISTINCT FROM ''bayn.entry-inference-input.v5''',
      'NOT COALESCE(source #>> ''{request,schemaVersion}'' IN (''bayn.entry-inference-input.v5'', ''bayn.entry-ablation-input.v1''), false)');
    END LOOP;
    definition := pg_get_functiondef('enforce_inference_expense_stage()'::regprocedure);
    IF position('source #>> ''{request,schemaVersion}''=''bayn.entry-inference-input.v5''' in definition) = 0 THEN
      RAISE EXCEPTION 'expected the current chart expense source guard' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition,
      'source #>> ''{request,schemaVersion}''=''bayn.entry-inference-input.v5''',
      'source #>> ''{request,schemaVersion}'' IN (''bayn.entry-inference-input.v5'', ''bayn.entry-ablation-input.v1'')');
  END $chart$`
  yield* sql`CREATE FUNCTION enforce_entry_completion_policy() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb; ready boolean; ablation boolean; outcome text;
    BEGIN
      IF NEW.payload #>> '{outcome,status}' IS DISTINCT FROM 'COMPLETED' THEN RETURN NEW; END IF;
      SELECT payload INTO STRICT source FROM jev_evaluation_requests WHERE request_id = NEW.request_id;
      ready := NEW.payload #>> '{outcome,completion,handoff,disposition,status}' = 'READY';
      ablation := source #>> '{request,schemaVersion}' = 'bayn.entry-ablation-input.v1';
      outcome := NEW.payload #>> '{outcome,completion,jev,status}';
      IF (ready AND ablation AND outcome IS DISTINCT FROM 'OMITTED_BY_POLICY')
        OR (ready AND NOT ablation AND outcome NOT IN ('RECEIVED', 'FAILED', 'NOT_DISPATCHED'))
        OR (NOT ready AND outcome IS DISTINCT FROM 'NOT_REQUESTED')
        OR ready IS NULL OR ablation IS NULL OR outcome IS NULL
      THEN RAISE EXCEPTION 'entry completion differs from its source provider policy' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER jev_evaluation_receipts_entry_policy BEFORE INSERT ON jev_evaluation_receipts
    FOR EACH ROW EXECUTE FUNCTION enforce_entry_completion_policy()`
  yield* sql`DO $protection$ DECLARE definition text; BEGIN
    definition := pg_get_functiondef('enforce_strategy_protection_plan()'::regprocedure);
    IF position('= ''bayn.jev-entry-target.v7''' in definition) = 0 THEN
      RAISE EXCEPTION 'expected the current entry protection guard' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, '= ''bayn.jev-entry-target.v7''',
      'IN (''bayn.jev-entry-target.v7'', ''bayn.entry-ablation-target.v1'', ''bayn.repeated-momentum-target.v1'')');
  END $protection$`
})
