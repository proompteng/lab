import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Add positive evidence without rewriting any retained terminal or expense quote.
  yield* sql`ALTER TABLE jev_staged_terminal_receipts
    DROP CONSTRAINT jev_staged_terminal_receipts_check,
    ADD CONSTRAINT jev_staged_terminal_receipts_check CHECK (
      payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'stage' IS NOT DISTINCT FROM stage
      AND payload->>'claimHash' IS NOT DISTINCT FROM claim_hash
      AND payload->>'terminalHash' IS NOT DISTINCT FROM terminal_hash
      AND ((payload->>'schemaVersion'='bayn.staged-terminal-receipt.v1'
        AND payload #>> '{outcome,status}' IN ('RECEIVED','FAILED'))
        OR (payload->>'schemaVersion'='bayn.staged-terminal-receipt.v2'
          AND payload #>> '{outcome,status}'='NOT_DISPATCHED')) IS TRUE)`
  yield* sql`CREATE FUNCTION enforce_visual_non_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE source jsonb; claim jsonb;
    BEGIN
      IF NEW.payload->>'schemaVersion'<>'bayn.staged-terminal-receipt.v2' THEN RETURN NEW; END IF;
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      SELECT payload INTO claim FROM jev_staged_dispatch_claims WHERE request_id=NEW.request_id AND stage=NEW.stage;
      IF NOT COALESCE(
        source->>'schemaVersion'='bayn.jev-evaluation-request.v3'
        AND source #>> '{request,protocol,schemaVersion}'='bayn.jev.protocol.v41'
        AND source #>> '{request,protocol,model}'='jev-1.14.0'
        AND NEW.stage='CHART'
        AND NEW.payload ?& ARRAY['schemaVersion','stage','requestId','claimHash','recordedAt','outcome','terminalHash']
        AND NEW.payload - ARRAY['schemaVersion','stage','requestId','claimHash','recordedAt','outcome','terminalHash']='{}'::jsonb
        AND (NEW.payload->'outcome') ?& ARRAY['status','reason','deadlineAt','checkedAt']
        AND (NEW.payload->'outcome') - ARRAY['status','reason','deadlineAt','checkedAt']='{}'::jsonb
        AND (NEW.payload #>> '{outcome,deadlineAt}')::timestamptz >= (source->>'observedAt')::timestamptz
        AND (NEW.payload #>> '{outcome,checkedAt}')::timestamptz >= (claim->>'claimedAt')::timestamptz
        AND (NEW.payload #>> '{outcome,checkedAt}')::timestamptz >= (NEW.payload #>> '{outcome,deadlineAt}')::timestamptz
        AND (NEW.payload->>'recordedAt')::timestamptz >= (NEW.payload #>> '{outcome,checkedAt}')::timestamptz
        AND ((NEW.payload #>> '{outcome,reason}'='ORIGINAL_EXPIRY'
          AND (NEW.payload #>> '{outcome,deadlineAt}')::timestamptz=(claim->>'expiresAt')::timestamptz)
          OR (NEW.payload #>> '{outcome,reason}'='ADMISSION_EXPIRY'
            AND (NEW.payload #>> '{outcome,deadlineAt}')::timestamptz<(claim->>'expiresAt')::timestamptz)),false)
        OR EXISTS (SELECT 1 FROM jev_inference_handoffs WHERE request_id=NEW.request_id)
        OR EXISTS (SELECT 1 FROM jev_evaluation_receipts WHERE request_id=NEW.request_id)
        OR (NEW.payload #>> '{outcome,reason}'='ADMISSION_EXPIRY' AND EXISTS (
          SELECT 1 FROM jev_inference_work work JOIN jev_batch_plans plan USING(batch_id)
          WHERE plan.cycle_id=source->>'cycleId'
            AND work.dispatches @> jsonb_build_array(jsonb_build_object('requestId',NEW.request_id))
            AND work.admission_deadline_at IS DISTINCT FROM (NEW.payload #>> '{outcome,deadlineAt}')::timestamptz))
      THEN RAISE EXCEPTION 'visual non-dispatch must retain its original uncalled deadline and claim' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$`
  yield* sql`CREATE TRIGGER staged_terminal_non_dispatch BEFORE INSERT ON jev_staged_terminal_receipts
    FOR EACH ROW EXECUTE FUNCTION enforce_visual_non_dispatch()`
  yield* sql`ALTER TABLE inference_expense_quotes
    ADD COLUMN not_dispatched_terminal_hash text GENERATED ALWAYS AS (payload #>> '{line,notDispatchedByTerminalHash}') STORED,
    ADD COLUMN not_dispatched_terminal_stage text GENERATED ALWAYS AS (
      CASE WHEN payload #>> '{line,notDispatchedByTerminalHash}' IS NOT NULL THEN 'CHART' END) STORED,
    ADD FOREIGN KEY(request_id,not_dispatched_terminal_stage,not_dispatched_terminal_hash)
      REFERENCES jev_staged_terminal_receipts(request_id,stage,terminal_hash),
    DROP CONSTRAINT inference_expense_staged_identity,
    ADD CONSTRAINT inference_expense_staged_identity UNIQUE NULLS NOT DISTINCT
      (request_id,provider_stage,receipt_hash,handoff_hash,chart_claim_hash,chart_terminal_hash,
        stage_claim_hash,stage_terminal_hash,stage_skip_hash,not_dispatched_terminal_hash),
    DROP CONSTRAINT inference_expense_quotes_check,
    ADD CONSTRAINT inference_expense_quotes_check CHECK (
      jsonb_typeof(payload)='object'
      AND (payload->>'schemaVersion' IN ('bayn.inference-expense-quote.v1','bayn.inference-expense-quote.v2',
        'bayn.inference-expense-quote.v3','bayn.inference-expense-quote.v4','bayn.inference-expense-quote.v5')) IS TRUE
      AND payload->>'quoteHash' IS NOT DISTINCT FROM quote_hash
      AND payload->>'sessionDate' IS NOT DISTINCT FROM session_date::text)`
  yield* sql`DO $migration$
    DECLARE definition text; updated text;
    BEGIN
      definition:=pg_get_functiondef('enforce_inference_expense_stage()'::regprocedure);
      IF strpos(definition,'DECLARE source jsonb; claim jsonb;')=0
        OR strpos(definition,'bayn.inference-expense-quote.v4')=0 THEN
        RAISE EXCEPTION 'unexpected inference expense predecessor' USING ERRCODE='55000'; END IF;
      updated:=replace(definition,'DECLARE source jsonb; claim jsonb;',
        'DECLARE source jsonb; claim jsonb; non_dispatch jsonb;');
      updated:=replace(updated,E'    BEGIN\n',$guard$    BEGIN
      IF NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v5' THEN
        SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id=NEW.payload #>> '{line,requestId}' FOR UPDATE;
        SELECT payload INTO non_dispatch FROM jev_staged_terminal_receipts
          WHERE request_id=NEW.payload #>> '{line,requestId}' AND stage='CHART'
            AND terminal_hash=NEW.payload #>> '{line,notDispatchedByTerminalHash}';
        IF NOT COALESCE(source->>'schemaVersion'='bayn.jev-evaluation-request.v3'
          AND source #>> '{request,protocol,schemaVersion}'='bayn.jev.protocol.v41'
          AND source->>'cycleId'=NEW.payload #>> '{line,cycleId}'
          AND EXISTS (SELECT 1 FROM autonomous_cycles cycle WHERE cycle.cycle_id=source->>'cycleId'
            AND cycle.account_id=NEW.account_id AND cycle.execution_session_date=NEW.session_date)
          AND NEW.payload #>> '{line,model}'=source #>> '{request,protocol,model}'
          AND NEW.payload #>> '{line,purpose}'='ENTRY'
          AND non_dispatch->>'schemaVersion'='bayn.staged-terminal-receipt.v2'
          AND non_dispatch #>> '{outcome,status}'='NOT_DISPATCHED'
          AND NEW.payload->'rate'='null'::jsonb
          AND NEW.payload #>> '{line,rateHash}' IS NULL
          AND NEW.payload #>> '{line,usageStatus}'='NOT_DISPATCHED'
          AND NEW.payload #>> '{line,inputTokens}'='0' AND NEW.payload #>> '{line,outputTokens}'='0'
          AND NEW.payload #>> '{line,cachedInputTokens}'='0' AND NEW.payload #>> '{line,cacheWriteInputTokens}'='0'
          AND NEW.payload #>> '{line,estimatedCostPicoUsd}'='0'
          AND NEW.payload #>> '{line,receiptHash}' IS NULL AND NEW.payload #>> '{line,resolutionHash}' IS NULL
          AND NEW.payload #>> '{line,handoffHash}' IS NULL AND NEW.payload #>> '{line,chartClaimHash}' IS NULL
          AND NEW.payload #>> '{line,chartTerminalHash}' IS NULL AND NEW.payload #>> '{line,stageSkipHash}' IS NULL
          AND ((NEW.payload #>> '{line,stage}'='CHART'
              AND NEW.payload #>> '{line,stageClaimHash}'=non_dispatch->>'claimHash'
              AND NEW.payload #>> '{line,stageTerminalHash}'=non_dispatch->>'terminalHash')
            OR (NEW.payload #>> '{line,stage}'='JEV' AND NEW.payload #>> '{line,stageClaimHash}' IS NULL
              AND NEW.payload #>> '{line,stageTerminalHash}' IS NULL)),false)
          OR EXISTS (SELECT 1 FROM jev_inference_handoffs WHERE request_id=NEW.payload #>> '{line,requestId}')
          OR EXISTS (SELECT 1 FROM jev_evaluation_receipts WHERE request_id=NEW.payload #>> '{line,requestId}')
        THEN RAISE EXCEPTION 'non-dispatch expense must identify its exact positive terminal proof' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.payload->'line' ? 'notDispatchedByTerminalHash' OR EXISTS (
        SELECT 1 FROM jev_staged_terminal_receipts WHERE request_id=NEW.payload #>> '{line,requestId}'
          AND terminal_hash=NEW.payload #>> '{line,stageTerminalHash}'
          AND payload->>'schemaVersion'='bayn.staged-terminal-receipt.v2')
      THEN RAISE EXCEPTION 'positive non-dispatch expenses require their versioned proof' USING ERRCODE='23514'; END IF;
$guard$);
      IF updated=definition OR strpos(updated,'non-dispatch expense must identify')=0 THEN
        RAISE EXCEPTION 'inference expense proof guard was not installed' USING ERRCODE='55000'; END IF;
      EXECUTE updated;
      definition:=pg_get_functiondef('inference_expense_source_needs_quotes(text)'::regprocedure);
      updated:=replace(definition,
        'LEFT JOIN inference_expense_quotes AS quote ON quote.request_id = request.request_id',
        $coverage$LEFT JOIN inference_expense_quotes AS quote ON quote.request_id = request.request_id
        AND quote.not_dispatched_terminal_hash IS NOT DISTINCT FROM (
          SELECT terminal_hash FROM jev_staged_terminal_receipts WHERE request_id=request.request_id AND stage='CHART'
            AND payload->>'schemaVersion'='bayn.staged-terminal-receipt.v2' AND payload #>> '{outcome,status}'='NOT_DISPATCHED')$coverage$);
      updated:=replace(updated,
        'AND resolution.request_id IS NULL THEN',
        $coverage$AND resolution.request_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM jev_staged_terminal_receipts WHERE request_id=request.request_id AND stage='CHART'
            AND payload->>'schemaVersion'='bayn.staged-terminal-receipt.v2' AND payload #>> '{outcome,status}'='NOT_DISPATCHED') THEN$coverage$);
      IF updated=definition OR strpos(updated,'quote.not_dispatched_terminal_hash')=0 THEN
        RAISE EXCEPTION 'inference expense coverage predecessor changed' USING ERRCODE='55000'; END IF;
      EXECUTE updated;
    END $migration$`
})
