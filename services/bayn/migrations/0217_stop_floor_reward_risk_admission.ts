import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/** Admit bayn.jev.protocol.v43 stop-floor and reward-risk protocol after a settled, flat OBSERVE cutover. */
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
    IF EXISTS (SELECT 1 FROM authority_state WHERE maximum IS DISTINCT FROM 'OBSERVE'
        OR effective IS DISTINCT FROM 'OBSERVE' OR kill_state IS DISTINCT FROM 'CLEAR' OR reason IS NOT NULL)
      OR EXISTS (SELECT 1 FROM intents WHERE state <> 'TERMINAL')
      OR EXISTS (SELECT 1 FROM autonomous_cycles WHERE state IN ('PENDING','ACTIVE'))
      OR EXISTS (
        SELECT 1 FROM (
          SELECT account_id,symbol,quantity_delta_atoms AS quantity,cost_basis_delta_micros AS cost FROM accounting_transactions
          UNION ALL SELECT account_id,symbol,-quantity_atoms,-cost_basis_micros FROM broker_inventory_debits WHERE posted
        ) inventory GROUP BY account_id,symbol HAVING sum(quantity)<>0 OR sum(cost)<>0)
      OR EXISTS (
        SELECT 1 FROM (SELECT DISTINCT ON (account_id) position_count FROM position_snapshots
          ORDER BY account_id,observed_at DESC,snapshot_id DESC) latest WHERE position_count<>0)
      OR EXISTS (SELECT 1 FROM accounting_transactions t LEFT JOIN accounting_receipts r USING (broker_event_id) WHERE r.receipt_id IS NULL)
      OR EXISTS (SELECT 1 FROM fills f LEFT JOIN accounting_transactions t ON t.broker_event_id=f.event_id WHERE t.transaction_id IS NULL)
      OR ((EXISTS (SELECT 1 FROM authority_state) OR EXISTS (SELECT 1 FROM intents) OR EXISTS (SELECT 1 FROM autonomous_cycles))
        AND EXISTS (
          SELECT 1 FROM (SELECT DISTINCT ON (o.account_id,o.broker_order_id) o.status FROM orders o JOIN broker_events e USING(event_id)
            ORDER BY o.account_id,o.broker_order_id,e.source_sequence DESC) latest WHERE status IN ('NEW','PENDING','PARTIALLY_FILLED','HELD')))
      OR EXISTS (
        SELECT 1 FROM authority_state a JOIN authority_generations g USING(generation_hash)
        LEFT JOIN LATERAL (SELECT status,reconciled_at FROM reconciliations r WHERE r.account_id=g.account_id
          ORDER BY reconciled_at DESC,reconciliation_id DESC LIMIT 1) latest ON true
        WHERE latest.status IS DISTINCT FROM 'EXACT' OR latest.reconciled_at IS NULL
          OR latest.reconciled_at>clock_timestamp() OR latest.reconciled_at<clock_timestamp()-interval '60 seconds'
          OR latest.reconciled_at<(SELECT max(occurred_at) FROM mutation_events m JOIN intents i USING(intent_id) WHERE i.account_id=g.account_id))
      OR EXISTS (
        SELECT 1 FROM jev_evaluation_requests request LEFT JOIN jev_evaluation_resolutions resolution USING(request_id)
        WHERE resolution.request_id IS NULL AND (request.payload->>'expiresAt')::timestamptz>clock_timestamp())
    THEN RAISE EXCEPTION 'stop-floor reward-risk cutover requires OBSERVE authority, terminal cycles, flat inventory, settled orders, fresh exact reconciliation, complete accounting and expired or resolved inference'
      USING ERRCODE='55000'; END IF;
  END $cutover$`
  yield* sql`DO $migration$
    DECLARE definition text; constraint_name text; guard regprocedure;
    BEGIN
      FOREACH constraint_name IN ARRAY ARRAY['authority_generations_strategy_parameter_schema_version_check','authority_generations_strategy_contract_check'] LOOP
        SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
          WHERE conrelid='authority_generations'::regclass AND conname=constraint_name;
        IF strpos(definition,'''bayn.jev.protocol.v42''')=0 OR strpos(definition,'''bayn.jev.protocol.v43''')<>0 THEN
          RAISE EXCEPTION 'unexpected stop-floor reward-risk authority predecessor' USING ERRCODE='55000'; END IF;
        EXECUTE format('ALTER TABLE authority_generations DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',constraint_name,constraint_name,
          replace(replace(definition,' NOT VALID',''),'''bayn.jev.protocol.v42''::text','''bayn.jev.protocol.v42''::text, ''bayn.jev.protocol.v43''::text'));
      END LOOP;

      SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
        WHERE conrelid='jev_evaluation_requests'::regclass AND conname='jev_evaluation_requests_check';
      IF strpos(definition,'''bayn.jev.protocol.v42''')=0 OR strpos(definition,'26fdef322e448b597429bb6ccd0c51d118102128d4d50291f30fc799867ed4bf')=0 THEN
        RAISE EXCEPTION 'unexpected stop-floor reward-risk request predecessor' USING ERRCODE='55000'; END IF;
      ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check,
        ADD CONSTRAINT jev_evaluation_requests_check CHECK (
          jsonb_typeof(payload) = 'object'
          AND payload ->> 'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-request.v3'
          AND payload ->> 'requestId' IS NOT DISTINCT FROM request_id
          AND payload ->> 'cycleId' IS NOT DISTINCT FROM cycle_id
          AND payload ->> 'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
          AND (payload #>> '{request,schemaVersion}') = ANY (ARRAY['bayn.entry-inference-input.v8'::text, 'bayn.entry-ablation-input.v1'::text])
          AND (payload #>> '{request,protocol,schemaVersion}') IS NOT DISTINCT FROM 'bayn.jev.protocol.v43'
          AND (payload #>> '{request,protocol,inputDefinition}') IS NOT DISTINCT FROM 'bayn.jev-entry-state.v24'
          AND (payload #>> '{request,numericalState,schemaVersion}') IS NOT DISTINCT FROM 'bayn.jev-entry-state.v24'
          AND jsonb_typeof(payload #> '{request,numericalState,webullContext}') = ANY (ARRAY['object'::text, 'null'::text])
          AND (
            (payload #> '{request,numericalState,entryEconomics}') = 'null'::jsonb
            OR CASE WHEN position('/' IN COALESCE(payload #>> '{request,chartSource,symbol}', '')) > 0
              THEN (payload #> '{request,numericalState,entryEconomics,maximumEntryQuoteDriftBps}') = '0'::jsonb
                AND (payload #> '{request,numericalState,entryEconomics,maximumEntryLimitSlippageBps}') = '0'::jsonb
              ELSE (payload #> '{request,numericalState,entryEconomics,maximumEntryQuoteDriftBps}') = '5'::jsonb
                AND (payload #> '{request,numericalState,entryEconomics,maximumEntryLimitSlippageBps}') = '5'::jsonb
            END
          )
          AND (payload #> '{request,protocol,lookbackMinutes}') IS NOT DISTINCT FROM '{"crypto": 120, "equity": 30}'::jsonb
          AND (payload #>> '{request,protocol,candidateEvidencePolicy}') IS NOT DISTINCT FROM 'bayn.candidate-evidence.market-quotes.v2'
          AND (payload #>> '{request,protocol,entryQuestionPolicyHash}') IS NOT DISTINCT FROM '26fdef322e448b597429bb6ccd0c51d118102128d4d50291f30fc799867ed4bf'
        ) NOT VALID;

      ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_box_model_check,
        ADD CONSTRAINT jev_box_model_check CHECK (
          payload #>> '{request,protocol,schemaVersion}' NOT IN ('bayn.jev.protocol.v40','bayn.jev.protocol.v41','bayn.jev.protocol.v42','bayn.jev.protocol.v43')
          OR payload #>> '{request,protocol,model}' IS NOT DISTINCT FROM 'jev-1.14.0'
        ) NOT VALID;

      FOREACH guard IN ARRAY ARRAY['enforce_current_entry_protocol()'::regprocedure,'enforce_inference_expense_stage()'::regprocedure] LOOP
        definition:=pg_get_functiondef(guard);
        IF strpos(definition,'''bayn.jev.protocol.v42'')')=0 THEN RAISE EXCEPTION 'unexpected stop-floor reward-risk evidence predecessor' USING ERRCODE='55000'; END IF;
        definition:=replace(definition,'''bayn.jev.protocol.v42'')','''bayn.jev.protocol.v42'', ''bayn.jev.protocol.v43'')');
        IF guard='enforce_inference_expense_stage()'::regprocedure THEN
          IF strpos(definition,'source #>> ''{request,protocol,schemaVersion}''=''bayn.jev.protocol.v42''')=0 THEN
            RAISE EXCEPTION 'unexpected stop-floor reward-risk expense policy predecessor' USING ERRCODE='55000'; END IF;
          definition:=replace(definition,
            'source #>> ''{request,protocol,schemaVersion}''=''bayn.jev.protocol.v42''',
            'source #>> ''{request,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v42'',''bayn.jev.protocol.v43'')');
        END IF;
        EXECUTE definition;
      END LOOP;

      FOREACH guard IN ARRAY ARRAY['enforce_staged_terminal_receipt()'::regprocedure,'enforce_entry_inference_handoff()'::regprocedure,'inference_expense_source_needs_quotes(text)'::regprocedure] LOOP
        definition:=pg_get_functiondef(guard);
        IF strpos(definition,'IN (''bayn.jev.protocol.v40'',''bayn.jev.protocol.v41'',''bayn.jev.protocol.v42'')')=0 THEN
          RAISE EXCEPTION 'unexpected stop-floor reward-risk two-stage predecessor' USING ERRCODE='55000'; END IF;
        EXECUTE replace(definition,'IN (''bayn.jev.protocol.v40'',''bayn.jev.protocol.v41'',''bayn.jev.protocol.v42'')','IN (''bayn.jev.protocol.v40'',''bayn.jev.protocol.v41'',''bayn.jev.protocol.v42'',''bayn.jev.protocol.v43'')');
      END LOOP;

      definition:=pg_get_functiondef('enforce_staged_dispatch_claim()'::regprocedure);
      IF strpos(definition,'''bayn.jev.protocol.v42''')=0 THEN
        RAISE EXCEPTION 'unexpected stop-floor reward-risk dispatch predecessor' USING ERRCODE='55000'; END IF;
      EXECUTE replace(definition,'''bayn.jev.protocol.v42''','''bayn.jev.protocol.v43''');

      definition:=pg_get_functiondef('enforce_visual_non_dispatch()'::regprocedure);
      IF strpos(definition,'AND source #>> ''{request,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v41'',''bayn.jev.protocol.v42'')')=0 THEN
        RAISE EXCEPTION 'unexpected stop-floor reward-risk non-dispatch predecessor' USING ERRCODE='55000'; END IF;
      EXECUTE replace(definition,
        'AND source #>> ''{request,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v41'',''bayn.jev.protocol.v42'')',
        'AND source #>> ''{request,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v41'',''bayn.jev.protocol.v42'',''bayn.jev.protocol.v43'')');

      definition:=pg_get_functiondef('enforce_strategy_protection_plan()'::regprocedure);
      IF strpos(definition,'root #>> ''{strategyDecision,evidence,observation,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v41'',''bayn.jev.protocol.v42'')')=0 THEN
        RAISE EXCEPTION 'unexpected stop-floor reward-risk protection predecessor' USING ERRCODE='55000'; END IF;
      EXECUTE replace(definition,
        'root #>> ''{strategyDecision,evidence,observation,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v41'',''bayn.jev.protocol.v42'')',
        'root #>> ''{strategyDecision,evidence,observation,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v41'',''bayn.jev.protocol.v42'',''bayn.jev.protocol.v43'')');
    END $migration$`
})
