import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/** Admit bayn.jev.protocol.v44 after a settled, flat OBSERVE cutover. */
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
    THEN RAISE EXCEPTION 'positive-net-target cutover requires OBSERVE authority, terminal cycles, flat inventory, settled orders, fresh exact reconciliation, complete accounting and expired or resolved inference'
      USING ERRCODE='55000'; END IF;
  END $cutover$`
  yield* sql`DO $migration$
    DECLARE
      definition text;
      constraint_row record;
      guard regprocedure;
      predecessor constant text := 'bayn.jev.protocol.v43';
      successor constant text := 'bayn.jev.protocol.v44';
    BEGIN
      FOR constraint_row IN SELECT conrelid::regclass AS relation, conname AS name, pg_get_constraintdef(oid) AS ddl
        FROM pg_constraint
        WHERE (conrelid='authority_generations'::regclass AND conname IN (
          'authority_generations_strategy_parameter_schema_version_check', 'authority_generations_strategy_contract_check'
        )) OR (conrelid='jev_evaluation_requests'::regclass AND conname IN (
          'jev_evaluation_requests_check', 'jev_box_model_check'
        ))
      LOOP
        IF strpos(constraint_row.ddl, quote_literal(predecessor) || '::text')=0
            OR strpos(constraint_row.ddl, quote_literal(successor))>0 THEN
          RAISE EXCEPTION 'unexpected positive-net-target constraint predecessor: %', constraint_row.name USING ERRCODE='55000';
        END IF;
        definition := replace(constraint_row.ddl, ' NOT VALID', '');
        definition := CASE WHEN constraint_row.name='jev_evaluation_requests_check'
          THEN replace(definition, quote_literal(predecessor), quote_literal(successor))
          ELSE replace(definition, quote_literal(predecessor) || '::text',
            quote_literal(predecessor) || '::text, ' || quote_literal(successor) || '::text')
        END;
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',
          constraint_row.relation, constraint_row.name, constraint_row.name, definition);
      END LOOP;

      -- The request and dispatch claim admit only the current protocol. Completion and expense
      -- guards must still recognize previously claimed or retained v43 evidence.
      FOREACH guard IN ARRAY ARRAY[
        'enforce_current_entry_protocol()'::regprocedure,
        'enforce_inference_expense_stage()'::regprocedure,
        'enforce_staged_terminal_receipt()'::regprocedure,
        'enforce_entry_inference_handoff()'::regprocedure,
        'inference_expense_source_needs_quotes(text)'::regprocedure,
        'enforce_staged_dispatch_claim()'::regprocedure,
        'enforce_visual_non_dispatch()'::regprocedure,
        'enforce_strategy_protection_plan()'::regprocedure
      ] LOOP
        definition := pg_get_functiondef(guard);
        IF strpos(definition, quote_literal(predecessor))=0
            OR strpos(definition, quote_literal(successor))>0 THEN
          RAISE EXCEPTION 'unexpected positive-net-target guard predecessor: %', guard USING ERRCODE='55000';
        END IF;
        EXECUTE replace(definition, quote_literal(predecessor),
          CASE WHEN guard='enforce_staged_dispatch_claim()'::regprocedure THEN quote_literal(successor)
          ELSE quote_literal(predecessor) || ', ' || quote_literal(successor) END);
      END LOOP;
    END $migration$`
})
