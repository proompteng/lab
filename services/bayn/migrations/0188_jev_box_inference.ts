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
      RAISE EXCEPTION 'Jev Box cutover requires terminal cycles, OBSERVE authority, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims'
        USING ERRCODE = '55000';
    END IF;
  END $cutover$`
  yield* sql`DO $migration$
    DECLARE definition text; constraint_name text; guard regprocedure;
    BEGIN
      FOREACH constraint_name IN ARRAY ARRAY['authority_generations_strategy_parameter_schema_version_check','authority_generations_strategy_contract_check'] LOOP
        SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
          WHERE conrelid='authority_generations'::regclass AND conname=constraint_name;
        IF strpos(definition, '''bayn.jev.protocol.v39''')=0 OR strpos(definition, '''bayn.jev.protocol.v40''')<>0 THEN
          RAISE EXCEPTION 'unexpected prior Jev Box authority constraint' USING ERRCODE='55000';
        END IF;
        EXECUTE format('ALTER TABLE authority_generations DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',
          constraint_name,constraint_name,replace(replace(definition,' NOT VALID',''),'''bayn.jev.protocol.v39''','''bayn.jev.protocol.v39'', ''bayn.jev.protocol.v40'''));
      END LOOP;
      SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
        WHERE conrelid='jev_evaluation_requests'::regclass AND conname='jev_evaluation_requests_check';
      IF strpos(definition, '''bayn.jev.protocol.v39''')=0 OR strpos(definition,'885a786fd4f29564b999c745a5740e0087fcf63aced4d92dcf6b98f0d8a7270f')=0 THEN
        RAISE EXCEPTION 'unexpected prior Jev Box request constraint' USING ERRCODE='55000';
      END IF;
      EXECUTE 'ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check, ADD CONSTRAINT jev_evaluation_requests_check '
        || replace(replace(replace(definition,' NOT VALID',''),'''bayn.jev.protocol.v39''','''bayn.jev.protocol.v40'''),
          '885a786fd4f29564b999c745a5740e0087fcf63aced4d92dcf6b98f0d8a7270f','ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442') || ' NOT VALID';
      ALTER TABLE jev_evaluation_requests ADD CONSTRAINT jev_box_model_check CHECK (payload #>> '{request,protocol,schemaVersion}' <> 'bayn.jev.protocol.v40' OR payload #>> '{request,protocol,model}' IS NOT DISTINCT FROM 'jev-1.14.0') NOT VALID;
      FOREACH guard IN ARRAY ARRAY['enforce_current_entry_protocol()'::regprocedure,'enforce_inference_expense_stage()'::regprocedure] LOOP
        definition:=pg_get_functiondef(guard);
        IF strpos(definition, '''bayn.jev.protocol.v39''')=0 THEN
          RAISE EXCEPTION 'unexpected prior Jev Box financial evidence protocol' USING ERRCODE='55000';
        END IF;
        definition:=replace(definition,'''bayn.jev.protocol.v39''','''bayn.jev.protocol.v39'', ''bayn.jev.protocol.v40''');
        IF guard='enforce_inference_expense_stage()'::regprocedure THEN
          definition:=replace(definition,'''885a786fd4f29564b999c745a5740e0087fcf63aced4d92dcf6b98f0d8a7270f''',
            '''885a786fd4f29564b999c745a5740e0087fcf63aced4d92dcf6b98f0d8a7270f'', ''ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442''');
          definition:=replace(definition,'      RETURN NEW;',$guard$
      IF source #>> '{request,protocol,schemaVersion}'='bayn.jev.protocol.v40' AND NOT COALESCE(
        NEW.payload #>> '{line,model}'='jev-1.14.0'
        AND (NEW.payload->'rate'='null'::jsonb OR NEW.payload #>> '{rate,provider}'='typesafe')
        AND NEW.payload #>> '{line,stage}' IN ('CHART','JEV')
        AND NEW.payload #>> '{line,stageSkipHash}' IS NULL,false)
      THEN RAISE EXCEPTION 'Box expense must identify its actual v14 call' USING ERRCODE='23514'; END IF;
      RETURN NEW;$guard$);
        END IF;
        EXECUTE definition;
      END LOOP;
      definition:=pg_get_functiondef('enforce_staged_terminal_receipt()'::regprocedure);
      IF strpos(definition, '''bayn.jev.protocol.v39''')=0 THEN
        RAISE EXCEPTION 'unexpected prior Jev Box terminal protocol' USING ERRCODE='55000';
      END IF;
      EXECUTE replace(definition,'CASE WHEN source #>>',
        'CASE WHEN source #>> ''{request,protocol,schemaVersion}''=''bayn.jev.protocol.v40'' THEN ''jev-1.14.0'' WHEN source #>>');
      definition:=pg_get_functiondef('enforce_entry_inference_handoff()'::regprocedure);
      EXECUTE replace(definition,'NEW.payload->>''schemaVersion''=''bayn.entry-handoff.v4''',
        'NEW.payload->>''schemaVersion''=CASE WHEN source #>> ''{request,protocol,schemaVersion}''=''bayn.jev.protocol.v40'' THEN ''bayn.entry-handoff.v5'' ELSE ''bayn.entry-handoff.v4'' END');
    END $migration$`
  yield* sql`ALTER TABLE jev_inference_handoffs DROP CONSTRAINT jev_inference_handoffs_check,
    ADD CONSTRAINT jev_inference_handoffs_check CHECK (
      jsonb_typeof(payload)='object'
      AND (payload->>'schemaVersion' IN ('bayn.entry-handoff.v1','bayn.entry-handoff.v2','bayn.entry-handoff.v3','bayn.entry-handoff.v4','bayn.entry-handoff.v5')) IS TRUE
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'handoffHash' IS NOT DISTINCT FROM handoff_hash
      AND (payload #>> '{disposition,status}' IN ('SOURCE_INFEASIBLE','VISUAL_FAILED','PREPARATION_FAILED')
        OR (payload #>> '{disposition,status}' IN ('NO_FUNDED_PROPOSALS','READY')
          AND payload #>> '{disposition,assessments,schemaVersion}'=CASE payload->>'schemaVersion'
            WHEN 'bayn.entry-handoff.v1' THEN 'bayn.chart-assessments.v1'
            WHEN 'bayn.entry-handoff.v2' THEN 'bayn.chart-assessments.v2'
            WHEN 'bayn.entry-handoff.v3' THEN 'bayn.chart-assessments.v3' ELSE 'bayn.chart-assessments.v4' END)) IS TRUE
    ) NOT VALID`
  yield* sql`ALTER TABLE jev_evaluation_receipts DROP CONSTRAINT jev_evaluation_receipts_check,
    ADD CONSTRAINT jev_evaluation_receipts_check CHECK (
      jsonb_typeof(payload)='object'
      AND (payload->>'schemaVersion' IN ('bayn.jev-evaluation-receipt.v2','bayn.jev-evaluation-receipt.v3')) IS TRUE
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'receiptHash' IS NOT DISTINCT FROM receipt_hash
      AND (payload #>> '{outcome,status}'='FAILED'
        OR (payload #>> '{outcome,status}'='COMPLETED'
          AND payload #>> '{outcome,completion,handoff,schemaVersion}' IN ('bayn.entry-handoff.v1','bayn.entry-handoff.v2','bayn.entry-handoff.v3','bayn.entry-handoff.v4','bayn.entry-handoff.v5'))) IS TRUE
    ) NOT VALID`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_staged_dispatch_claim() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb; account text; admission_at timestamptz;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      SELECT account_id INTO account FROM autonomous_cycles WHERE cycle_id=source->>'cycleId';
      admission_at := execution_account_commit_now(account);
      IF source->>'schemaVersion' IS DISTINCT FROM 'bayn.jev-evaluation-request.v3'
        OR source #>> '{request,schemaVersion}' NOT IN ('bayn.entry-inference-input.v8','bayn.entry-ablation-input.v1')
        OR source #>> '{request,protocol,schemaVersion}' IS DISTINCT FROM 'bayn.jev.protocol.v40'
        OR source #>> '{request,protocol,model}' IS DISTINCT FROM 'jev-1.14.0'
        OR source #>> '{request,protocol,entryQuestionPolicyHash}' IS DISTINCT FROM 'ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442'
        OR NEW.stage IS DISTINCT FROM 'CHART'
        OR NEW.payload->>'predecessorHash' IS NOT NULL OR NEW.payload->>'selectedEnd' IS NOT NULL
        OR NEW.payload->>'expiresAt' IS DISTINCT FROM source->>'expiresAt'
        OR NOT COALESCE((NEW.payload->>'claimedAt')::timestamptz >= (source->>'observedAt')::timestamptz
          AND (NEW.payload->>'claimedAt')::timestamptz <= admission_at
          AND admission_at < (source->>'expiresAt')::timestamptz,false)
        OR EXISTS(SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=NEW.request_id)
        OR EXISTS(SELECT 1 FROM jev_inference_handoffs WHERE request_id=NEW.request_id)
        OR EXISTS(SELECT 1 FROM jev_staged_skip_receipts WHERE request_id=NEW.request_id)
        OR EXISTS(SELECT 1 FROM inference_expense_quotes WHERE request_id=NEW.request_id AND provider_stage=NEW.stage)
      THEN RAISE EXCEPTION 'Box dispatch requires one unexpired unresolved current CHART request' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`DO $migration$
    DECLARE definition text;
    BEGIN
      definition:=pg_get_functiondef('inference_expense_source_needs_quotes(text)'::regprocedure);
      IF strpos(definition,'THEN 3')=0 THEN
        RAISE EXCEPTION 'unexpected prior inference expense stage count' USING ERRCODE='55000';
      END IF;
      EXECUTE replace(definition,'THEN 3',
        'THEN CASE WHEN request.payload #>> ''{request,protocol,schemaVersion}''=''bayn.jev.protocol.v40'' THEN 2 ELSE 3 END');
    END $migration$`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_staged_skip_receipt() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      RAISE EXCEPTION 'retired BASE_START cannot create new skips' USING ERRCODE='23514';
    END $function$`
  yield* sql`DO $migration$
    DECLARE definition text;
    BEGIN
      definition:=pg_get_functiondef('enforce_staged_checkpoint_handoff()'::regprocedure);
      EXECUTE replace(definition,'      IF NEW.payload->>''schemaVersion''<>''bayn.entry-handoff.v4'' THEN RETURN NEW; END IF;',$guard$
      IF NEW.payload->>'schemaVersion'='bayn.entry-handoff.v5' THEN
        PERFORM 1 FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
        SELECT payload INTO chart FROM jev_staged_terminal_receipts WHERE request_id=NEW.request_id AND stage='CHART';
        IF NEW.payload ? 'baseStart'
          OR EXISTS(SELECT 1 FROM jev_staged_skip_receipts WHERE request_id=NEW.request_id)
          OR EXISTS(SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=NEW.request_id AND stage<>'CHART')
        THEN RAISE EXCEPTION 'Box handoff cannot contain BASE_START evidence' USING ERRCODE='23514'; END IF;
        IF NEW.payload #>> '{disposition,status}'='SOURCE_INFEASIBLE' THEN
          IF EXISTS(SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=NEW.request_id)
          THEN RAISE EXCEPTION 'source-infeasible handoff omits a dispatch' USING ERRCODE='23514'; END IF;
        ELSIF chart IS NULL OR NOT COALESCE(
          (chart #>> '{outcome,status}'='RECEIVED' AND chart #> '{outcome,inference}'=NEW.payload #> '{disposition,visual}')
          OR (chart #>> '{outcome,status}'='FAILED' AND NEW.payload #>> '{disposition,status}'='VISUAL_FAILED'
            AND chart #> '{outcome,failure}'=NEW.payload #> '{disposition,failure}'),false)
        THEN RAISE EXCEPTION 'Box handoff changes its committed chart outcome' USING ERRCODE='23514'; END IF;
        IF chart IS NOT NULL AND (chart->>'recordedAt')::timestamptz > (NEW.payload->>'recordedAt')::timestamptz
        THEN RAISE EXCEPTION 'Box handoff precedes committed visual evidence' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.payload->>'schemaVersion'<>'bayn.entry-handoff.v4' THEN RETURN NEW; END IF;$guard$);
    END $migration$`
})
