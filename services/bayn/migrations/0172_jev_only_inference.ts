import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Preserve financial history and the existing flat, reconciled native protocol cutover boundary.
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
      RAISE EXCEPTION 'Jev-only cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims'
        USING ERRCODE = '55000';
    END IF;
  END $cutover$`
  yield* sql`DO $migration$
    DECLARE definition text; constraint_name text; guard regprocedure;
    BEGIN
      FOREACH constraint_name IN ARRAY ARRAY['authority_generations_strategy_parameter_schema_version_check','authority_generations_strategy_contract_check'] LOOP
        SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint WHERE conrelid='authority_generations'::regclass AND conname=constraint_name;
        IF strpos(definition, '''bayn.jev.protocol.v36''')=0 THEN RAISE EXCEPTION 'unexpected prior authority protocol constraint' USING ERRCODE='55000'; END IF;
        EXECUTE format('ALTER TABLE authority_generations DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',constraint_name,constraint_name,replace(replace(definition,' NOT VALID',''),'''bayn.jev.protocol.v36''','''bayn.jev.protocol.v36'', ''bayn.jev.protocol.v37'''));
      END LOOP;
      SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint WHERE conrelid='jev_evaluation_requests'::regclass AND conname='jev_evaluation_requests_check';
      IF strpos(definition, '''bayn.jev.protocol.v36''')=0 THEN RAISE EXCEPTION 'unexpected prior entry protocol constraint' USING ERRCODE='55000'; END IF;
      EXECUTE 'ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check, ADD CONSTRAINT jev_evaluation_requests_check ' || replace(replace(replace(definition,' NOT VALID',''),'''bayn.jev.protocol.v36''','''bayn.jev.protocol.v37'''),'f8972e59e7e09fa67aecc97b57e66d62d0aa4eabdad55fca16d785e50ae44325','0dd4b9c1a0b98df2878ad7fbbe3a1bac11571a50138cb1f0c883f89e3fedf9c5') || ' NOT VALID';
      FOREACH guard IN ARRAY ARRAY['enforce_staged_dispatch_claim()'::regprocedure,'enforce_staged_skip_receipt()'::regprocedure] LOOP
        definition:=pg_get_functiondef(guard);
        IF strpos(definition, '''bayn.jev.protocol.v36''')=0 OR strpos(definition,'f8972e59e7e09fa67aecc97b57e66d62d0aa4eabdad55fca16d785e50ae44325')=0 THEN RAISE EXCEPTION 'unexpected prior staged dispatch protocol' USING ERRCODE='55000'; END IF;
        definition:=replace(replace(replace(definition,'''bayn.jev.protocol.v36''','''bayn.jev.protocol.v37'''),'f8972e59e7e09fa67aecc97b57e66d62d0aa4eabdad55fca16d785e50ae44325','0dd4b9c1a0b98df2878ad7fbbe3a1bac11571a50138cb1f0c883f89e3fedf9c5'),'05b4cc847d516888abecf982abd8ca6207f62f8f642bd2381c44a9051717a305','0d919da70b2b19818f4e5df1047eee509354006166fe6a9c50eec97b353ca54d');
        definition:=replace(definition,'SELECT answer INTO selected FROM jsonb_array_elements(predecessor #> ''{outcome,inference,response,answers}'') answer WHERE answer->>''name''=''base_last_bar'';','selected := predecessor #> ''{outcome,inference,response,answers,base_last_bar}'';');
        EXECUTE definition;
      END LOOP;
      definition:=pg_get_functiondef('enforce_inference_expense_stage()'::regprocedure);
      EXECUTE replace(replace(definition,'''bayn.jev.protocol.v36''','''bayn.jev.protocol.v36'', ''bayn.jev.protocol.v37'''),'''f8972e59e7e09fa67aecc97b57e66d62d0aa4eabdad55fca16d785e50ae44325''','''f8972e59e7e09fa67aecc97b57e66d62d0aa4eabdad55fca16d785e50ae44325'', ''0dd4b9c1a0b98df2878ad7fbbe3a1bac11571a50138cb1f0c883f89e3fedf9c5''');
      definition:=pg_get_functiondef('enforce_current_entry_protocol()'::regprocedure);
      EXECUTE replace(definition,'''bayn.jev.protocol.v36''','''bayn.jev.protocol.v36'', ''bayn.jev.protocol.v37''');
    END $migration$`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_staged_terminal_receipt() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE claim jsonb; source jsonb;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      SELECT payload INTO claim FROM jev_staged_dispatch_claims WHERE request_id=NEW.request_id AND stage=NEW.stage;
      IF NOT COALESCE((NEW.payload->>'recordedAt')::timestamptz >= (claim->>'claimedAt')::timestamptz,false)
        OR (NEW.payload #>> '{outcome,status}'='RECEIVED' AND (
          NEW.payload #>> '{outcome,inference,requestHash}' IS DISTINCT FROM claim->>'providerRequestHash'
          OR NEW.payload #>> '{outcome,inference,response,model}' IS DISTINCT FROM
            CASE WHEN source #>> '{request,protocol,schemaVersion}'='bayn.jev.protocol.v37' THEN 'jev-1.13.0' ELSE 'gpt-6-luna' END
          OR NOT COALESCE((NEW.payload #>> '{outcome,inference,startedAt}')::timestamptz >= (claim->>'claimedAt')::timestamptz
            AND (NEW.payload #>> '{outcome,inference,startedAt}')::timestamptz < (claim->>'expiresAt')::timestamptz
            AND (NEW.payload #>> '{outcome,inference,completedAt}')::timestamptz >= (NEW.payload #>> '{outcome,inference,startedAt}')::timestamptz
            AND (NEW.payload #>> '{outcome,inference,completedAt}')::timestamptz <= (NEW.payload->>'recordedAt')::timestamptz,false)))
      THEN RAISE EXCEPTION 'stage terminal differs from its original provider and dispatch claim' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $function$`
})
