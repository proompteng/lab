import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`LOCK TABLE intents, mutation_events, autonomous_cycles, authority_state, authority_generations,
    broker_events, fills, orders, position_snapshots, accounting_transactions,
    accounting_receipts, broker_inventory_debits, reconciliations,
    jev_evaluation_requests, jev_evaluation_receipts, jev_inference_handoffs,
    jev_evaluation_resolutions, jev_chart_dispatch_claims, jev_chart_terminal_receipts,
    inference_expense_quotes, jev_staged_dispatch_claims, jev_staged_terminal_receipts,
    jev_staged_skip_receipts IN ACCESS EXCLUSIVE MODE`
  yield* sql`DO $cutover$ BEGIN
    IF EXISTS (SELECT 1 FROM intents WHERE state <> 'TERMINAL')
      OR EXISTS (SELECT 1 FROM autonomous_cycles WHERE state IN ('PENDING', 'ACTIVE'))
      OR EXISTS (
        SELECT 1 FROM (
          SELECT account_id, symbol, quantity_delta_atoms AS quantity, cost_basis_delta_micros AS cost
            FROM accounting_transactions
          UNION ALL SELECT account_id, symbol, -quantity_atoms, -cost_basis_micros
            FROM broker_inventory_debits WHERE posted
        ) inventory GROUP BY account_id, symbol HAVING sum(quantity) <> 0 OR sum(cost) <> 0
      )
      OR EXISTS (
        SELECT 1 FROM (SELECT DISTINCT account_id FROM position_snapshots) accounts
        CROSS JOIN LATERAL (
          SELECT position_count FROM position_snapshots p WHERE p.account_id = accounts.account_id
          ORDER BY observed_at DESC, snapshot_id DESC LIMIT 1
        ) latest WHERE position_count <> 0
      )
      OR EXISTS (SELECT 1 FROM accounting_transactions t LEFT JOIN accounting_receipts r USING (broker_event_id) WHERE r.receipt_id IS NULL)
      OR EXISTS (SELECT 1 FROM fills f LEFT JOIN accounting_transactions t ON t.broker_event_id = f.event_id WHERE t.transaction_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (o.account_id, o.broker_order_id) o.status
          FROM orders o JOIN broker_events e USING (event_id)
          ORDER BY o.account_id, o.broker_order_id, e.source_sequence DESC
        ) latest WHERE status IN ('NEW', 'PENDING', 'PARTIALLY_FILLED', 'HELD')
      )
      OR EXISTS (
        SELECT 1 FROM authority_state a JOIN authority_generations g USING (generation_hash)
        LEFT JOIN LATERAL (
          SELECT status, reconciled_at FROM reconciliations r WHERE r.account_id = g.account_id
          ORDER BY reconciled_at DESC, reconciliation_id DESC LIMIT 1
        ) latest ON true
        WHERE a.maximum = 'PAPER' AND (
          latest.status IS DISTINCT FROM 'EXACT'
          OR latest.reconciled_at IS NULL
          OR latest.reconciled_at > clock_timestamp()
          OR latest.reconciled_at < clock_timestamp() - interval '60 seconds'
          OR latest.reconciled_at < (SELECT max(occurred_at) FROM mutation_events m JOIN intents i USING (intent_id) WHERE i.account_id = g.account_id)
        )
      )
      OR EXISTS (
        WITH unresolved AS MATERIALIZED (
          SELECT request.payload FROM jev_evaluation_requests request
          LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)
          WHERE resolution.request_id IS NULL
        )
        SELECT 1 FROM unresolved WHERE (payload->>'expiresAt')::timestamptz > clock_timestamp()
      )
    THEN RAISE EXCEPTION 'focused-entry-evidence cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims' USING ERRCODE = '55000'; END IF;
  END $cutover$`
  yield* sql`UPDATE authority_state SET effective='OBSERVE', kill_state='ACTIVE',
    reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER', version=version+1,
    updated_at=greatest(clock_timestamp(), updated_at + interval '1 millisecond')
    WHERE maximum='PAPER' AND (
      (effective='PAPER' AND kill_state='CLEAR') OR reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER'
    )`
  yield* sql`ALTER TABLE authority_generations
    DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
    DROP CONSTRAINT authority_generations_strategy_contract_check,
    ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
      strategy_parameter_schema_version IN ('bayn.jev.protocol.v32', 'bayn.entry-ablation-policy.v1', 'bayn.repeated-momentum-policy.v1')
    ) NOT VALID,
    ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
      ((maximum = 'OBSERVE' AND strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
        OR (maximum = 'PAPER' AND strategy_name = 'jev' AND strategy_parameter_schema_version IN (
          'bayn.jev.protocol.v32', 'bayn.entry-ablation-policy.v1', 'bayn.repeated-momentum-policy.v1')))
      IS TRUE
    ) NOT VALID`
  yield* sql`ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check,
    ADD CONSTRAINT jev_evaluation_requests_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-request.v3'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
      AND (payload #>> '{request,schemaVersion}' IN ('bayn.entry-inference-input.v6', 'bayn.entry-ablation-input.v1')) IS TRUE
      AND payload #>> '{request,protocol,schemaVersion}' IS NOT DISTINCT FROM 'bayn.jev.protocol.v32'
      AND payload #> '{request,protocol,lookbackMinutes}' IS NOT DISTINCT FROM '{"equity":30,"crypto":120}'::jsonb
      AND payload #>> '{request,protocol,candidateEvidencePolicy}' IS NOT DISTINCT FROM 'bayn.candidate-evidence.market-quotes.v2'
      AND payload #>> '{request,protocol,entryQuestionPolicyHash}' IS NOT DISTINCT FROM 'c6c8032291a3840de13db71ca02aaf8149b8d862e425cc24fdc5327b47cd3c03'
    ) NOT VALID`
  yield* sql`DO $dispatch$ DECLARE definition text; guard regprocedure; BEGIN
    FOREACH guard IN ARRAY ARRAY['enforce_staged_dispatch_claim()'::regprocedure, 'enforce_staged_skip_receipt()'::regprocedure] LOOP
      definition := pg_get_functiondef(guard);
      IF position('''bayn.jev.protocol.v31''' in definition) = 0
        OR position('''bayn.jev.protocol.v32''' in definition) <> 0 THEN
        RAISE EXCEPTION 'expected the retired staged protocol guard' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, '''bayn.jev.protocol.v31''', '''bayn.jev.protocol.v32''');
      IF position('abf1e97da2d6a9bdef380aa224cde4245aa332c2686976bb9d755ad9a1a60910' in definition) = 0 THEN
        RAISE EXCEPTION 'expected the retained question policy guard' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(definition, 'abf1e97da2d6a9bdef380aa224cde4245aa332c2686976bb9d755ad9a1a60910', 'c6c8032291a3840de13db71ca02aaf8149b8d862e425cc24fdc5327b47cd3c03');
    END LOOP;
  END $dispatch$`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_current_entry_protocol() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb;
    BEGIN
      SELECT payload INTO STRICT source FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      IF source #>> '{request,protocol,schemaVersion}' IS DISTINCT FROM 'bayn.jev.protocol.v32' THEN
        RAISE EXCEPTION 'retired entry protocol cannot create inference evidence' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $function$`
  // Late original outcomes remain financial evidence; they cannot start current execution.
  yield* sql`DO $cost$ DECLARE definition text; previous text; BEGIN
    definition := pg_get_functiondef('enforce_inference_expense_stage()'::regprocedure);
    previous := 'source #>> ''{request,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v30'', ''bayn.jev.protocol.v31'')';
    IF position(previous in definition) = 0 THEN
      RAISE EXCEPTION 'expected the retained staged financial evidence guard' USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, previous,
      'source #>> ''{request,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v30'', ''bayn.jev.protocol.v31'', ''bayn.jev.protocol.v32'')');
    previous := 'source #>> ''{request,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v26'', ''bayn.jev.protocol.v27'', ''bayn.jev.protocol.v28'', ''bayn.jev.protocol.v29'', ''bayn.jev.protocol.v30'', ''bayn.jev.protocol.v31'')';
    IF position(previous in definition) = 0 THEN
      RAISE EXCEPTION 'expected the retained ablation financial evidence guard' USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, previous,
      'source #>> ''{request,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v26'', ''bayn.jev.protocol.v27'', ''bayn.jev.protocol.v28'', ''bayn.jev.protocol.v29'', ''bayn.jev.protocol.v30'', ''bayn.jev.protocol.v31'', ''bayn.jev.protocol.v32'')');
    previous := 'source #>> ''{request,protocol,entryQuestionPolicyHash}'' IN (''05b4cc847d516888abecf982abd8ca6207f62f8f642bd2381c44a9051717a305'',''abf1e97da2d6a9bdef380aa224cde4245aa332c2686976bb9d755ad9a1a60910'')';
    IF position(previous in definition) = 0 THEN
      RAISE EXCEPTION 'expected the retained financial question policy guard' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, previous,
      'source #>> ''{request,protocol,entryQuestionPolicyHash}'' IN (''05b4cc847d516888abecf982abd8ca6207f62f8f642bd2381c44a9051717a305'',''abf1e97da2d6a9bdef380aa224cde4245aa332c2686976bb9d755ad9a1a60910'',''c6c8032291a3840de13db71ca02aaf8149b8d862e425cc24fdc5327b47cd3c03'')');
  END $cost$`
})
