import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE jev_chart_dispatch_claims (
    request_id text PRIMARY KEY REFERENCES jev_evaluation_requests(request_id),
    claim_hash text NOT NULL UNIQUE CHECK (claim_hash ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (
      payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.chart-dispatch-claim.v1'
      AND payload->>'stage' IS NOT DISTINCT FROM 'CHART'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'claimHash' IS NOT DISTINCT FROM claim_hash
      AND (payload->>'providerRequestHash' ~ '^[0-9a-f]{64}$') IS TRUE),
    UNIQUE(request_id,claim_hash)
  )`
  yield* sql`CREATE TABLE jev_chart_terminal_receipts (
    request_id text PRIMARY KEY,
    claim_hash text NOT NULL,
    terminal_hash text NOT NULL UNIQUE CHECK (terminal_hash ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (
      payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.chart-terminal-receipt.v1'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'claimHash' IS NOT DISTINCT FROM claim_hash
      AND payload->>'terminalHash' IS NOT DISTINCT FROM terminal_hash
      AND (payload #>> '{outcome,status}' IN ('RECEIVED','FAILED')) IS TRUE),
    FOREIGN KEY(request_id,claim_hash) REFERENCES jev_chart_dispatch_claims(request_id,claim_hash),
    UNIQUE(request_id,terminal_hash)
  )`
  yield* sql`CREATE FUNCTION enforce_chart_dispatch_claim() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      IF source->>'schemaVersion' IS DISTINCT FROM 'bayn.jev-evaluation-request.v2'
        OR source #>> '{request,schemaVersion}' IS DISTINCT FROM 'bayn.entry-inference-input.v3'
        OR source #>> '{request,protocol,schemaVersion}' IS DISTINCT FROM 'bayn.jev.protocol.v24'
        OR source #>> '{request,protocol,entryQuestionPolicyHash}' IS DISTINCT FROM 'd35ee4093641285aa36385c4ab35de978de7485ff754bebb523648adf80c8939'
        OR NEW.payload->>'expiresAt' IS DISTINCT FROM source->>'expiresAt'
        OR NOT COALESCE((NEW.payload->>'claimedAt')::timestamptz >= (source->>'observedAt')::timestamptz
          AND (NEW.payload->>'claimedAt')::timestamptz <= clock_timestamp()
          AND clock_timestamp() < (source->>'expiresAt')::timestamptz, false)
        OR EXISTS (SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=NEW.request_id)
        OR EXISTS (SELECT 1 FROM jev_inference_handoffs WHERE request_id=NEW.request_id)
        OR EXISTS (SELECT 1 FROM inference_expense_quotes WHERE request_id=NEW.request_id AND provider_stage='CHART')
      THEN RAISE EXCEPTION 'chart dispatch requires one unexpired unresolved current-protocol request' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER jev_chart_claim_source BEFORE INSERT ON jev_chart_dispatch_claims
    FOR EACH ROW EXECUTE FUNCTION enforce_chart_dispatch_claim()`
  yield* sql`CREATE FUNCTION enforce_chart_terminal_receipt() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE claim jsonb;
    BEGIN
      PERFORM 1 FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      SELECT payload INTO claim FROM jev_chart_dispatch_claims WHERE request_id=NEW.request_id;
      IF NOT COALESCE((NEW.payload->>'recordedAt')::timestamptz >= (claim->>'claimedAt')::timestamptz, false)
      THEN RAISE EXCEPTION 'chart terminal receipt precedes its dispatch claim' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER jev_chart_terminal_source BEFORE INSERT ON jev_chart_terminal_receipts
    FOR EACH ROW EXECUTE FUNCTION enforce_chart_terminal_receipt()`
  // Late usage creates a new quote identity without changing historical evidence.
  yield* sql`ALTER TABLE inference_expense_quotes
    ADD COLUMN chart_claim_hash text GENERATED ALWAYS AS (payload #>> '{line,chartClaimHash}') STORED,
    ADD COLUMN chart_terminal_hash text GENERATED ALWAYS AS (payload #>> '{line,chartTerminalHash}') STORED`
  yield* sql`DO $identity$ DECLARE constraint_name text; BEGIN
    SELECT conname INTO STRICT constraint_name FROM pg_constraint
      WHERE conrelid='inference_expense_quotes'::regclass AND contype='u'
        AND pg_get_constraintdef(oid)='UNIQUE NULLS NOT DISTINCT (request_id, provider_stage, receipt_hash, handoff_hash)';
    EXECUTE format('ALTER TABLE inference_expense_quotes DROP CONSTRAINT %I', constraint_name);
  END $identity$`
  yield* sql`ALTER TABLE inference_expense_quotes
    ADD CONSTRAINT inference_expense_checkpoint_identity UNIQUE NULLS NOT DISTINCT
      (request_id, provider_stage, receipt_hash, handoff_hash, chart_claim_hash, chart_terminal_hash),
    ADD FOREIGN KEY (request_id, chart_claim_hash) REFERENCES jev_chart_dispatch_claims(request_id,claim_hash),
    ADD FOREIGN KEY (request_id, chart_terminal_hash) REFERENCES jev_chart_terminal_receipts(request_id,terminal_hash),
    DROP CONSTRAINT inference_expense_quotes_check,
    ADD CONSTRAINT inference_expense_quotes_check CHECK (
      jsonb_typeof(payload)='object'
      AND (payload->>'schemaVersion' IN ('bayn.inference-expense-quote.v1','bayn.inference-expense-quote.v2','bayn.inference-expense-quote.v3')) IS TRUE
      AND payload->>'quoteHash' IS NOT DISTINCT FROM quote_hash
      AND payload->>'sessionDate' IS NOT DISTINCT FROM session_date::text)`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_inference_expense_stage() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb; claim jsonb;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id=NEW.payload #>> '{line,requestId}' FOR UPDATE;
      SELECT payload INTO claim FROM jev_chart_dispatch_claims WHERE request_id=NEW.payload #>> '{line,requestId}';
      IF NOT COALESCE(
        (source->>'schemaVersion'='bayn.jev-evaluation-request.v1' AND NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v1')
        OR (source->>'schemaVersion'='bayn.jev-evaluation-request.v2' AND NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v2'
          AND NEW.payload #>> '{line,stage}' IN ('CHART','JEV')
          AND (NEW.payload #>> '{line,stage}'='JEV' OR claim IS NULL))
        OR (source->>'schemaVersion'='bayn.jev-evaluation-request.v2'
          AND source #>> '{request,schemaVersion}'='bayn.entry-inference-input.v3'
          AND source #>> '{request,protocol,schemaVersion}'='bayn.jev.protocol.v24'
          AND source #>> '{request,protocol,entryQuestionPolicyHash}'='d35ee4093641285aa36385c4ab35de978de7485ff754bebb523648adf80c8939'
          AND NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v3'
          AND NEW.payload #>> '{line,stage}'='CHART'
          AND claim->>'claimHash'=NEW.payload #>> '{line,chartClaimHash}'
          AND NEW.payload #>> '{line,receiptHash}' IS NULL
          AND NEW.payload #>> '{line,handoffHash}' IS NULL), false)
      THEN RAISE EXCEPTION 'inference expense must identify the actual provider stage and checkpoint' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE FUNCTION enforce_chart_checkpoint_handoff() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE terminal jsonb;
    BEGIN
      PERFORM 1 FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM jev_chart_dispatch_claims WHERE request_id=NEW.request_id) THEN
        SELECT payload INTO terminal FROM jev_chart_terminal_receipts WHERE request_id=NEW.request_id;
        IF terminal IS NULL OR NOT COALESCE(
          (terminal->>'recordedAt')::timestamptz <= (NEW.payload->>'recordedAt')::timestamptz
          AND ((terminal #>> '{outcome,status}'='RECEIVED'
            AND terminal #> '{outcome,inference}'=NEW.payload #> '{disposition,visual}')
            OR (terminal #>> '{outcome,status}'='FAILED'
              AND NEW.payload #>> '{disposition,status}'='VISUAL_FAILED'
              AND terminal #> '{outcome,failure}'=NEW.payload #> '{disposition,failure}')), false)
        THEN RAISE EXCEPTION 'handoff requires its exact committed chart terminal receipt' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER jev_handoff_chart_checkpoint BEFORE INSERT ON jev_inference_handoffs
    FOR EACH ROW EXECUTE FUNCTION enforce_chart_checkpoint_handoff()`
  yield* sql`CREATE FUNCTION enforce_chart_checkpoint_receipt() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      PERFORM 1 FROM jev_evaluation_requests WHERE request_id=NEW.request_id FOR UPDATE;
      IF NEW.payload #>> '{outcome,failure}'='NOT_DISPATCHED'
        AND EXISTS (SELECT 1 FROM jev_chart_dispatch_claims WHERE request_id=NEW.request_id)
      THEN RAISE EXCEPTION 'undispatched receipt cannot omit a committed chart claim' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER jev_receipt_chart_checkpoint BEFORE INSERT ON jev_evaluation_receipts
    FOR EACH ROW EXECUTE FUNCTION enforce_chart_checkpoint_receipt()`
  for (const table of ['jev_chart_dispatch_claims', 'jev_chart_terminal_receipts']) {
    yield* sql`CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON ${sql(table)}
      FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
    yield* sql`CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${sql(table)}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  }
})
