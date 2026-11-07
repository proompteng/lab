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
  // A reviewed OBSERVE cutover and native settlement must precede this source release.
  // This migration never changes authority, grants, mandates, or retained financial evidence.
  yield* sql`DO $cutover$ BEGIN
    IF EXISTS (
      SELECT 1 FROM authority_state WHERE maximum IS DISTINCT FROM 'OBSERVE'
        OR effective IS DISTINCT FROM 'OBSERVE' OR kill_state IS DISTINCT FROM 'CLEAR' OR reason IS NOT NULL
    )
      OR EXISTS (SELECT 1 FROM intents WHERE state <> 'TERMINAL')
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
        WHERE
          latest.status IS DISTINCT FROM 'EXACT'
          OR latest.reconciled_at IS NULL
          OR latest.reconciled_at > clock_timestamp()
          OR latest.reconciled_at < clock_timestamp() - interval '60 seconds'
          OR latest.reconciled_at < (SELECT max(occurred_at) FROM mutation_events m JOIN intents i USING (intent_id) WHERE i.account_id = g.account_id)
      )
      OR EXISTS (
        WITH unresolved AS MATERIALIZED (
          SELECT request.payload FROM jev_evaluation_requests request
          LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)
          WHERE resolution.request_id IS NULL
        )
        SELECT 1 FROM unresolved WHERE (payload->>'expiresAt')::timestamptz > clock_timestamp()
      )
    THEN
      RAISE EXCEPTION 'effective-entry-allowance cutover requires terminal cycles, OBSERVE authority, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims'
        USING ERRCODE = '55000';
    END IF;
  END $cutover$`
  yield* sql`DO $migration$
    DECLARE definition text; constraint_name text; guard regprocedure;
    BEGIN
      FOREACH constraint_name IN ARRAY ARRAY['authority_generations_strategy_parameter_schema_version_check','authority_generations_strategy_contract_check'] LOOP
        SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
          WHERE conrelid='authority_generations'::regclass AND conname=constraint_name;
        IF strpos(definition, '''bayn.jev.protocol.v38''')=0 OR strpos(definition, '''bayn.jev.protocol.v39''')<>0 THEN
          RAISE EXCEPTION 'unexpected prior effective-entry-allowance authority constraint' USING ERRCODE='55000';
        END IF;
        EXECUTE format('ALTER TABLE authority_generations DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',
          constraint_name,constraint_name,replace(replace(definition,' NOT VALID',''),'''bayn.jev.protocol.v38''','''bayn.jev.protocol.v38'', ''bayn.jev.protocol.v39'''));
      END LOOP;
      FOREACH guard IN ARRAY ARRAY['enforce_staged_dispatch_claim()'::regprocedure,'enforce_staged_skip_receipt()'::regprocedure] LOOP
        definition:=pg_get_functiondef(guard);
        IF strpos(definition, '''bayn.jev.protocol.v38''')=0 OR strpos(definition, '''bayn.jev.protocol.v39''')<>0 THEN
          RAISE EXCEPTION 'unexpected prior effective-entry-allowance dispatch protocol' USING ERRCODE='55000';
        END IF;
        EXECUTE replace(definition,'''bayn.jev.protocol.v38''','''bayn.jev.protocol.v39''');
      END LOOP;
      FOREACH guard IN ARRAY ARRAY['enforce_inference_expense_stage()'::regprocedure,
        'enforce_current_entry_protocol()'::regprocedure,'enforce_staged_terminal_receipt()'::regprocedure] LOOP
        definition:=pg_get_functiondef(guard);
        IF strpos(definition, '''bayn.jev.protocol.v38''')=0 OR strpos(definition, '''bayn.jev.protocol.v39''')<>0 THEN
          RAISE EXCEPTION 'unexpected prior effective-entry-allowance evidence protocol' USING ERRCODE='55000';
        END IF;
        EXECUTE replace(definition,'''bayn.jev.protocol.v38''','''bayn.jev.protocol.v38'', ''bayn.jev.protocol.v39''');
      END LOOP;
    END $migration$`
  yield* sql`ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check,
    ADD CONSTRAINT jev_evaluation_requests_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-request.v3'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
      AND (payload #>> '{request,schemaVersion}' IN ('bayn.entry-inference-input.v8', 'bayn.entry-ablation-input.v1')) IS TRUE
      AND payload #>> '{request,protocol,schemaVersion}' IS NOT DISTINCT FROM 'bayn.jev.protocol.v39'
      AND payload #>> '{request,protocol,inputDefinition}' IS NOT DISTINCT FROM 'bayn.jev-entry-state.v24'
      AND payload #>> '{request,numericalState,schemaVersion}' IS NOT DISTINCT FROM 'bayn.jev-entry-state.v24'
      AND (jsonb_typeof(payload #> '{request,numericalState,webullContext}') IN ('object','null')) IS TRUE
      AND (payload #> '{request,numericalState,entryEconomics}' = 'null'::jsonb OR (
        payload #> '{request,numericalState,entryEconomics,maximumEntryQuoteDriftBps}' = '0'::jsonb
        AND payload #> '{request,numericalState,entryEconomics,maximumEntryLimitSlippageBps}' = '0'::jsonb
      )) IS TRUE
      AND payload #> '{request,protocol,lookbackMinutes}' IS NOT DISTINCT FROM '{"equity":30,"crypto":120}'::jsonb
      AND payload #>> '{request,protocol,candidateEvidencePolicy}' IS NOT DISTINCT FROM 'bayn.candidate-evidence.market-quotes.v2'
      AND payload #>> '{request,protocol,entryQuestionPolicyHash}' IS NOT DISTINCT FROM '885a786fd4f29564b999c745a5740e0087fcf63aced4d92dcf6b98f0d8a7270f'
    ) NOT VALID`
})
