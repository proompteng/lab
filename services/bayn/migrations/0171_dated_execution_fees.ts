import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Preserve the existing protocol cutover boundary before moving the successor to OBSERVE.
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
    THEN
      RAISE EXCEPTION 'dated-execution-fee cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims'
        USING ERRCODE = '55000';
    END IF;
  END $cutover$`
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
