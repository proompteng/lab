import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/** Admit native JeV shorts only after a settled, flat OBSERVE cutover. Retained evidence is immutable. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`LOCK TABLE intents, mutation_events, autonomous_cycles, authority_state, authority_generations,
    broker_events, fills, orders, position_snapshots, accounting_transactions,
    accounting_receipts, broker_inventory_debits, reconciliations,
    jev_evaluation_requests, jev_evaluation_receipts, jev_inference_handoffs,
    jev_evaluation_resolutions, jev_staged_dispatch_claims, jev_staged_terminal_receipts,
    inference_expense_quotes IN ACCESS EXCLUSIVE MODE`
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
      OR EXISTS (
        SELECT 1 FROM (SELECT DISTINCT ON (o.account_id,o.broker_order_id) o.status FROM orders o JOIN broker_events e USING(event_id)
          ORDER BY o.account_id,o.broker_order_id,e.source_sequence DESC) latest WHERE status IN ('NEW','PENDING','PARTIALLY_FILLED','HELD'))
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
    THEN RAISE EXCEPTION 'native equity short cutover requires OBSERVE authority, terminal cycles, flat inventory, settled orders, fresh exact reconciliation, complete accounting and expired or resolved inference'
      USING ERRCODE='55000'; END IF;
  END $cutover$`
  yield* sql`DO $migration$
    DECLARE definition text; constraint_name text; guard regprocedure;
    BEGIN
      FOREACH constraint_name IN ARRAY ARRAY['authority_generations_strategy_parameter_schema_version_check','authority_generations_strategy_contract_check'] LOOP
        SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
          WHERE conrelid='authority_generations'::regclass AND conname=constraint_name;
        IF strpos(definition,'''bayn.jev.protocol.v40''')=0 OR strpos(definition,'''bayn.jev.protocol.v41''')<>0 THEN
          RAISE EXCEPTION 'unexpected native short authority predecessor' USING ERRCODE='55000'; END IF;
        EXECUTE format('ALTER TABLE authority_generations DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',constraint_name,constraint_name,
          replace(replace(definition,' NOT VALID',''),'''bayn.jev.protocol.v40''','''bayn.jev.protocol.v40'', ''bayn.jev.protocol.v41'''));
      END LOOP;
      SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
        WHERE conrelid='jev_evaluation_requests'::regclass AND conname='jev_evaluation_requests_check';
      IF strpos(definition,'''bayn.jev.protocol.v40''')=0 OR strpos(definition,'ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442')=0 THEN
        RAISE EXCEPTION 'unexpected native short request predecessor' USING ERRCODE='55000'; END IF;
      EXECUTE 'ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check, ADD CONSTRAINT jev_evaluation_requests_check '
        || replace(replace(replace(definition,' NOT VALID',''),'''bayn.jev.protocol.v40''','''bayn.jev.protocol.v41'''),
          'ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442','1ae578128813903c7b052fa8cde378db708001e99f599f4bb6fba3596dfdc895') || ' NOT VALID';
      ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_box_model_check,
        ADD CONSTRAINT jev_box_model_check CHECK (payload #>> '{request,protocol,schemaVersion}' NOT IN ('bayn.jev.protocol.v40','bayn.jev.protocol.v41')
          OR payload #>> '{request,protocol,model}' IS NOT DISTINCT FROM 'jev-1.14.0') NOT VALID;
      FOREACH guard IN ARRAY ARRAY['enforce_current_entry_protocol()'::regprocedure,'enforce_inference_expense_stage()'::regprocedure] LOOP
        definition:=pg_get_functiondef(guard);
        IF strpos(definition,'''bayn.jev.protocol.v40''')=0 THEN RAISE EXCEPTION 'unexpected native short evidence predecessor' USING ERRCODE='55000'; END IF;
        definition:=replace(definition,'''bayn.jev.protocol.v40'')','''bayn.jev.protocol.v40'', ''bayn.jev.protocol.v41'')');
        IF guard='enforce_inference_expense_stage()'::regprocedure THEN
          definition:=replace(definition,'''ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442'')',
            '''ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442'', ''1ae578128813903c7b052fa8cde378db708001e99f599f4bb6fba3596dfdc895'')');
          definition:=replace(definition,'source #>> ''{request,protocol,schemaVersion}''=''bayn.jev.protocol.v40'' AND NOT COALESCE(',
            'source #>> ''{request,protocol,schemaVersion}'' IN (''bayn.jev.protocol.v40'',''bayn.jev.protocol.v41'') AND NOT COALESCE(');
          definition:=replace(definition,'      RETURN NEW;',$guard$
      IF source #>> '{request,protocol,schemaVersion}'='bayn.jev.protocol.v41'
        AND source #>> '{request,protocol,entryQuestionPolicyHash}' IS DISTINCT FROM '1ae578128813903c7b052fa8cde378db708001e99f599f4bb6fba3596dfdc895'
      THEN RAISE EXCEPTION 'native short expense changes the source judgment policy' USING ERRCODE='23514'; END IF;
      RETURN NEW;$guard$);
        END IF;
        EXECUTE definition;
      END LOOP;
      FOREACH guard IN ARRAY ARRAY['enforce_staged_terminal_receipt()'::regprocedure,'enforce_entry_inference_handoff()'::regprocedure,'inference_expense_source_needs_quotes(text)'::regprocedure] LOOP
        definition:=pg_get_functiondef(guard);
        IF strpos(definition,'''bayn.jev.protocol.v40'' THEN')=0 THEN RAISE EXCEPTION 'unexpected native short two-stage predecessor' USING ERRCODE='55000'; END IF;
        EXECUTE replace(definition,'=''bayn.jev.protocol.v40'' THEN',' IN (''bayn.jev.protocol.v40'',''bayn.jev.protocol.v41'') THEN');
      END LOOP;
      definition:=pg_get_functiondef('enforce_staged_dispatch_claim()'::regprocedure);
      IF strpos(definition,'''bayn.jev.protocol.v40''')=0 OR strpos(definition,'ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442')=0 THEN
        RAISE EXCEPTION 'unexpected native short dispatch predecessor' USING ERRCODE='55000'; END IF;
      EXECUTE replace(replace(definition,'''bayn.jev.protocol.v40''','''bayn.jev.protocol.v41'''),
        'ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442','1ae578128813903c7b052fa8cde378db708001e99f599f4bb6fba3596dfdc895');
      SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint WHERE conrelid='intents'::regclass AND conname='intents_explicit_limit_terms_check';
      IF strpos(definition,'''StopLimit''')=0 THEN RAISE EXCEPTION 'unexpected stop-limit predecessor' USING ERRCODE='55000'; END IF;
      EXECUTE 'ALTER TABLE intents DROP CONSTRAINT intents_explicit_limit_terms_check, ADD CONSTRAINT intents_explicit_limit_terms_check '
        || replace(replace(definition,' NOT VALID',''),'= ''StopLimit''::text','= ANY (ARRAY[''StopLimit''::text,''EquityShortStopLimit''::text])') || ' NOT VALID';
      FOREACH guard IN ARRAY ARRAY['paper_cycle_completion_evidence_matches(text,text,timestamptz)'::regprocedure,
        'retain_submission_decision_admission()'::regprocedure] LOOP
        definition:=pg_get_functiondef(guard);
        IF strpos(definition,'''Oco'',''StopLimit''')=0 THEN RAISE EXCEPTION 'unexpected protective admission or completion predecessor' USING ERRCODE='55000'; END IF;
        EXECUTE replace(definition,'''Oco'',''StopLimit''','''Oco'',''StopLimit'',''EquityShortOco'',''EquityShortStopLimit''');
      END LOOP;
      definition:=pg_get_functiondef('enforce_strategy_protection_plan()'::regprocedure);
      IF strpos(definition,'      tag := NEW.protection ->> ''_tag'';')=0 THEN RAISE EXCEPTION 'unexpected strategy protection predecessor' USING ERRCODE='55000'; END IF;
      EXECUTE replace(definition,'      tag := NEW.protection ->> ''_tag'';',$guard$
      tag := NEW.protection ->> '_tag';
      IF tag IN ('EquityShortBracket','EquityShortOco','EquityShortStopLimit') THEN
        SELECT d.document INTO root FROM autonomous_cycle_shadow_decisions d WHERE d.cycle_id=NEW.cycle_id AND (
          (tag='EquityShortBracket' AND d.document->'orderedIntentIds' ? NEW.intent_id)
          OR (tag IN ('EquityShortOco','EquityShortStopLimit') AND d.decision_hash=NEW.protection->>'entryDecisionHash'));
        plan:=root #> ARRAY['strategyDecision','exitPolicy','plans',NEW.symbol];
        IF NOT COALESCE(
          root #>> '{strategyDecision,schemaVersion}'='bayn.jev-entry-target.v7'
          AND root #>> '{strategyDecision,evidence,observation,protocol,schemaVersion}'='bayn.jev.protocol.v41'
          AND root #>> '{strategyDecision,evidence,observation,protocol,positionPolicy}'='equity-long-short'
          AND root #>> '{bindings,accountId}'=NEW.account_id AND NEW.strategy_name='jev'
          AND root #>> '{bindings,strategyDecisionHash}'=NEW.decision_hash
          AND root #>> '{bindings,policyHash}'=NEW.policy_hash
          AND plan->>'schemaVersion'='bayn.jev-short-funded-exit-plan.v1'
          AND plan #>> '{levels,schemaVersion}'='bayn.jev-short-strategy-exit-plan.v1'
          AND plan #>> '{levels,positionSide}'='SHORT' AND plan #>> '{levels,symbol}'=NEW.symbol
          AND NEW.quantity_atoms<=(plan->>'maximumQuantityAtoms')::numeric
          AND position('/' IN NEW.symbol)=0 AND mod(NEW.quantity_atoms,1000000000)=0 AND NEW.time_in_force='DAY'
          AND (root->>'createdAt')::timestamptz<=NEW.created_at
          AND (plan #>> '{levels,profitLimitPriceMicros}')::numeric<(plan #>> '{levels,minimumEntryPriceMicros}')::numeric
          AND (plan #>> '{levels,minimumEntryPriceMicros}')::numeric<(plan #>> '{levels,stopPriceMicros}')::numeric
          AND (plan #>> '{levels,stopPriceMicros}')::numeric<=(plan #>> '{levels,stopLimitPriceMicros}')::numeric
          AND NEW.protection->>'stopPriceMicros'=plan #>> '{levels,stopPriceMicros}'
          AND CASE WHEN tag='EquityShortStopLimit' THEN NEW.side='BUY' AND NEW.order_type='STOP_LIMIT'
            AND NEW.limit_price_micros=(plan #>> '{levels,stopLimitPriceMicros}')::numeric
          ELSE NEW.order_type='LIMIT'
            AND NEW.protection->>'stopLimitPriceMicros'=plan #>> '{levels,stopLimitPriceMicros}'
            AND NEW.protection->>'profitLimitPriceMicros'=plan #>> '{levels,profitLimitPriceMicros}'
            AND CASE WHEN tag='EquityShortBracket' THEN NEW.side='SELL'
              AND NEW.limit_price_micros>=(plan #>> '{levels,minimumEntryPriceMicros}')::numeric
              AND NEW.limit_price_micros<(plan #>> '{levels,stopPriceMicros}')::numeric
            ELSE NEW.side='BUY' AND NEW.limit_price_micros=(plan #>> '{levels,profitLimitPriceMicros}')::numeric END
          END,false)
        THEN RAISE EXCEPTION 'native short protection must bind its immutable equity short strategy plan' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END IF;$guard$);
    END $migration$`
})
