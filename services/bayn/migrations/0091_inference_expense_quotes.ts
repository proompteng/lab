import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE inference_expense_quotes (
      quote_hash text PRIMARY KEY CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
      account_id text NOT NULL,
      session_date date NOT NULL,
      payload jsonb NOT NULL CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.inference-expense-quote.v1'
        AND payload->>'quoteHash' IS NOT DISTINCT FROM quote_hash
        AND payload->>'sessionDate' IS NOT DISTINCT FROM session_date::text
      ),
      request_id text GENERATED ALWAYS AS (payload #>> '{line,requestId}') STORED NOT NULL
        REFERENCES jev_evaluation_requests (request_id),
      receipt_hash text GENERATED ALWAYS AS (payload #>> '{line,receiptHash}') STORED,
      created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      verified_at timestamptz,
      UNIQUE NULLS NOT DISTINCT (request_id, receipt_hash),
      FOREIGN KEY (request_id, receipt_hash) REFERENCES jev_evaluation_receipts (request_id, receipt_hash)
    )
  `
  yield* sql`CREATE INDEX inference_expense_quotes_pending
    ON inference_expense_quotes (account_id, quote_hash) WHERE verified_at IS NULL`
  yield* sql`CREATE INDEX inference_expense_quotes_session
    ON inference_expense_quotes (account_id, session_date, quote_hash)`
  yield* sql`CREATE INDEX autonomous_cycles_inference_expense_scope
    ON autonomous_cycles (account_id, execution_session_date, cycle_id)
    WHERE execution_session_date >= DATE '2026-10-05'`
  yield* sql`
    CREATE FUNCTION verify_inference_expense_quote_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.verified_at IS NOT NULL OR NEW.verified_at IS NULL
        OR ROW(NEW.quote_hash, NEW.account_id, NEW.session_date, NEW.payload, NEW.created_at)
          IS DISTINCT FROM ROW(OLD.quote_hash, OLD.account_id, OLD.session_date, OLD.payload, OLD.created_at) THEN
        RAISE EXCEPTION 'inference expense quotes are immutable except their first verification';
      END IF;
      RETURN NEW;
    END;
    $$
  `
  yield* sql`CREATE TRIGGER inference_expense_quotes_verify_once
    BEFORE UPDATE ON inference_expense_quotes FOR EACH ROW EXECUTE FUNCTION verify_inference_expense_quote_once()`
  yield* sql`CREATE TRIGGER inference_expense_quotes_reject_delete
    BEFORE DELETE ON inference_expense_quotes FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER inference_expense_quotes_reject_truncate
    BEFORE TRUNCATE ON inference_expense_quotes FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
