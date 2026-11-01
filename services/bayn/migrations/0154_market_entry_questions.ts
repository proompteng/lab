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
    THEN RAISE EXCEPTION 'market-entry-question cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims' USING ERRCODE = '55000'; END IF;
  END $cutover$`
  yield* sql`UPDATE authority_state SET effective='OBSERVE', kill_state='ACTIVE',
    reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER', version=version+1,
    updated_at=greatest(clock_timestamp(), updated_at + interval '1 millisecond')
    WHERE maximum='PAPER' AND (
      (effective='PAPER' AND kill_state='CLEAR') OR reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER'
    )`
  yield* sql`ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check,
    ADD CONSTRAINT jev_evaluation_requests_check CHECK (
      jsonb_typeof(payload)='object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-request.v3'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
      AND payload #>> '{request,schemaVersion}' IS NOT DISTINCT FROM 'bayn.entry-inference-input.v5'
      AND payload #>> '{request,protocol,schemaVersion}' IS NOT DISTINCT FROM 'bayn.jev.protocol.v26'
      AND payload #>> '{request,protocol,entryQuestionPolicyHash}' IS NOT DISTINCT FROM 'abf1e97da2d6a9bdef380aa224cde4245aa332c2686976bb9d755ad9a1a60910'
    ) NOT VALID`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_staged_dispatch_claim() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb; account text; admission_at timestamptz; predecessor jsonb; selected jsonb;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      SELECT account_id INTO account FROM autonomous_cycles WHERE cycle_id=source->>'cycleId';
      admission_at := execution_account_commit_now(account);
      IF source->>'schemaVersion' IS DISTINCT FROM 'bayn.jev-evaluation-request.v3'
        OR source #>> '{request,schemaVersion}' IS DISTINCT FROM 'bayn.entry-inference-input.v5'
        OR source #>> '{request,protocol,schemaVersion}' IS DISTINCT FROM 'bayn.jev.protocol.v26'
        OR source #>> '{request,protocol,entryQuestionPolicyHash}' IS DISTINCT FROM 'abf1e97da2d6a9bdef380aa224cde4245aa332c2686976bb9d755ad9a1a60910'
        OR NEW.payload->>'expiresAt' IS DISTINCT FROM source->>'expiresAt'
        OR NOT COALESCE((NEW.payload->>'claimedAt')::timestamptz >= (source->>'observedAt')::timestamptz
          AND (NEW.payload->>'claimedAt')::timestamptz <= admission_at
          AND admission_at < (source->>'expiresAt')::timestamptz,false)
        OR EXISTS(SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=NEW.request_id)
        OR EXISTS(SELECT 1 FROM jev_inference_handoffs WHERE request_id=NEW.request_id)
        OR EXISTS(SELECT 1 FROM jev_staged_skip_receipts WHERE request_id=NEW.request_id)
        OR EXISTS(SELECT 1 FROM inference_expense_quotes WHERE request_id=NEW.request_id AND provider_stage=NEW.stage)
      THEN RAISE EXCEPTION 'staged dispatch requires one unexpired unresolved current request' USING ERRCODE='23514'; END IF;
      IF NEW.stage='CHART' THEN
        IF NEW.payload->>'predecessorHash' IS NOT NULL OR NEW.payload->>'selectedEnd' IS NOT NULL
        THEN RAISE EXCEPTION 'initial chart cannot have a predecessor' USING ERRCODE='23514'; END IF;
      ELSE
        SELECT payload INTO predecessor FROM jev_staged_terminal_receipts WHERE request_id=NEW.request_id AND stage='CHART';
        SELECT answer INTO selected FROM jsonb_array_elements(predecessor #> '{outcome,inference,response,answers}') answer WHERE answer->>'name'='base_last_bar';
        IF predecessor #>> '{outcome,status}' IS DISTINCT FROM 'RECEIVED'
          OR predecessor->>'terminalHash' IS DISTINCT FROM NEW.payload->>'predecessorHash'
          OR selected->>'type' IS DISTINCT FROM 'choice'
          OR selected->>'choice' IS DISTINCT FROM NEW.payload->>'selectedEnd'
          OR selected->>'choice'='no_base'
          OR NOT COALESCE((NEW.payload->>'claimedAt')::timestamptz >= (predecessor->>'recordedAt')::timestamptz,false)
        THEN RAISE EXCEPTION 'base start requires its exact committed selected-end predecessor' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_staged_skip_receipt() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb; predecessor jsonb; selected jsonb;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      IF source->>'schemaVersion' IS DISTINCT FROM 'bayn.jev-evaluation-request.v3'
        OR source #>> '{request,schemaVersion}' IS DISTINCT FROM 'bayn.entry-inference-input.v5'
        OR source #>> '{request,protocol,schemaVersion}' IS DISTINCT FROM 'bayn.jev.protocol.v26'
        OR (source #>> '{request,protocol,entryQuestionPolicyHash}' IS DISTINCT FROM '05b4cc847d516888abecf982abd8ca6207f62f8f642bd2381c44a9051717a305' AND source #>> '{request,protocol,entryQuestionPolicyHash}' IS DISTINCT FROM 'abf1e97da2d6a9bdef380aa224cde4245aa332c2686976bb9d755ad9a1a60910')
        OR NOT COALESCE((NEW.payload->>'recordedAt')::timestamptz >= (source->>'observedAt')::timestamptz,false)
        OR EXISTS(SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=NEW.request_id AND stage='BASE_START')
      THEN RAISE EXCEPTION 'base-start skip conflicts with its original source or dispatch' USING ERRCODE='23514'; END IF;
      IF NEW.payload->>'reason'='SOURCE_INFEASIBLE' THEN
        IF NEW.payload->>'predecessorHash' IS NOT NULL OR EXISTS(SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=NEW.request_id)
        THEN RAISE EXCEPTION 'source skip cannot omit a dispatch' USING ERRCODE='23514'; END IF;
      ELSE
        SELECT payload INTO predecessor FROM jev_staged_terminal_receipts WHERE request_id=NEW.request_id AND stage='CHART';
        SELECT answer INTO selected FROM jsonb_array_elements(predecessor #> '{outcome,inference,response,answers}') answer WHERE answer->>'name'='base_last_bar';
        IF predecessor IS NULL OR predecessor->>'terminalHash' IS DISTINCT FROM NEW.payload->>'predecessorHash'
          OR NOT COALESCE((NEW.payload->>'recordedAt')::timestamptz >= (predecessor->>'recordedAt')::timestamptz,false)
          OR NOT COALESCE(
            (NEW.payload->>'reason'='CHART_FAILED' AND predecessor #>> '{outcome,status}'='FAILED')
            OR (predecessor #>> '{outcome,status}'='RECEIVED' AND (
              (NEW.payload->>'reason'='END_REFUSED' AND selected->>'type'='refusal')
              OR (NEW.payload->>'reason'='NO_BASE' AND selected->>'type'='choice' AND selected->>'choice'='no_base')
              OR (NEW.payload->>'reason'='INSUFFICIENT_BARS' AND selected IS NULL
                AND jsonb_array_length(source #> '{request,chartSource,bars}') < 3)
              OR (NEW.payload->>'reason'='NO_ELIGIBLE_BASE' AND selected IS NULL
                AND jsonb_array_length(source #> '{request,chartSource,bars}') >= 3))),false)
        THEN RAISE EXCEPTION 'skip does not match its committed chart outcome' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_inference_expense_stage() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb; claim jsonb;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id=NEW.payload #>> '{line,requestId}' FOR UPDATE;
      SELECT payload INTO claim FROM jev_chart_dispatch_claims WHERE request_id=NEW.payload #>> '{line,requestId}';
      IF NOT COALESCE(
        (source->>'schemaVersion'='bayn.jev-evaluation-request.v3'
          AND source #>> '{request,schemaVersion}'='bayn.entry-inference-input.v5'
          AND source #>> '{request,protocol,schemaVersion}'='bayn.jev.protocol.v26'
          AND source #>> '{request,protocol,entryQuestionPolicyHash}' IN ('05b4cc847d516888abecf982abd8ca6207f62f8f642bd2381c44a9051717a305','abf1e97da2d6a9bdef380aa224cde4245aa332c2686976bb9d755ad9a1a60910')
          AND NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v4'
          AND (NEW.payload #>> '{line,stage}') IN ('CHART','BASE_START','JEV')
          AND (NEW.payload #>> '{line,chartClaimHash}') IS NULL AND (NEW.payload #>> '{line,chartTerminalHash}') IS NULL
          AND (((NEW.payload #>> '{line,stage}')='JEV' AND EXISTS(SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=(NEW.payload #>> '{line,requestId}'))
                AND (NEW.payload #>> '{line,stageClaimHash}') IS NULL AND (NEW.payload #>> '{line,stageTerminalHash}') IS NULL AND (NEW.payload #>> '{line,stageSkipHash}') IS NULL)
            OR ((NEW.payload #>> '{line,stage}') IN ('CHART','BASE_START') AND (
              ((NEW.payload #>> '{line,stageClaimHash}') IS NOT NULL AND (NEW.payload #>> '{line,stageSkipHash}') IS NULL AND (NEW.payload #>> '{line,receiptHash}') IS NULL AND (NEW.payload #>> '{line,handoffHash}') IS NULL)
              OR ((NEW.payload #>> '{line,stageSkipHash}') IS NOT NULL AND (NEW.payload #>> '{line,stageClaimHash}') IS NULL AND (NEW.payload #>> '{line,stageTerminalHash}') IS NULL AND (NEW.payload #>> '{line,receiptHash}') IS NULL AND (NEW.payload #>> '{line,handoffHash}') IS NULL)
              OR (EXISTS(SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=(NEW.payload #>> '{line,requestId}'))
                AND (NEW.payload #>> '{line,stageClaimHash}') IS NULL AND (NEW.payload #>> '{line,stageTerminalHash}') IS NULL AND (NEW.payload #>> '{line,stageSkipHash}') IS NULL)))))
        OR (source->>'schemaVersion'='bayn.jev-evaluation-request.v1' AND NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v1')
        OR (source->>'schemaVersion'='bayn.jev-evaluation-request.v2' AND NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v2'
          AND NEW.payload #>> '{line,stage}' IN ('CHART','JEV')
          AND (NEW.payload #>> '{line,stage}'='JEV' OR claim IS NULL)
          AND (claim IS NULL OR EXISTS (SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=NEW.payload #>> '{line,requestId}')))
        OR (source->>'schemaVersion'='bayn.jev-evaluation-request.v2'
          AND ((source #>> '{request,schemaVersion}'='bayn.entry-inference-input.v3'
            AND source #>> '{request,protocol,schemaVersion}'='bayn.jev.protocol.v24'
            AND source #>> '{request,protocol,entryQuestionPolicyHash}'='d35ee4093641285aa36385c4ab35de978de7485ff754bebb523648adf80c8939')
            OR (source #>> '{request,schemaVersion}'='bayn.entry-inference-input.v4'
              AND source #>> '{request,protocol,schemaVersion}'='bayn.jev.protocol.v25'
              AND source #>> '{request,protocol,entryQuestionPolicyHash}'='7be14891e60d6e276aca0ac72ddd7102afe8193c9b6d1cdfd57da885e0078399'))
          AND NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v3'
          AND NEW.payload #>> '{line,stage}'='CHART'
          AND claim->>'claimHash'=NEW.payload #>> '{line,chartClaimHash}'
          AND NEW.payload #>> '{line,receiptHash}' IS NULL
          AND NEW.payload #>> '{line,handoffHash}' IS NULL), false)
      THEN RAISE EXCEPTION 'inference expense must identify the actual provider stage and checkpoint' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $function$`
})
