import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE research_inference_runs (
    run_id text PRIMARY KEY CHECK (run_id ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.research-run.v1'),
    claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
  )`
  yield* sql`CREATE TABLE research_inference_receipts (
    run_id text PRIMARY KEY REFERENCES research_inference_runs (run_id),
    receipt_hash text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (
      payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.research-receipt.v1'
      AND payload->>'runId' IS NOT DISTINCT FROM run_id
      AND payload->>'receiptHash' IS NOT DISTINCT FROM receipt_hash
      AND payload->>'qualification' IS NOT DISTINCT FROM 'UNQUALIFIED'
    ),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    verified_at timestamptz
  )`
  yield* sql`CREATE INDEX research_inference_receipts_pending ON research_inference_receipts (run_id) WHERE verified_at IS NULL`
  yield* sql`CREATE FUNCTION verify_research_expense_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.verified_at IS NOT NULL THEN
          RAISE EXCEPTION 'research receipt must start expense-unverified';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.verified_at IS NOT NULL OR NEW.verified_at IS NULL OR
        ROW(NEW.run_id, NEW.receipt_hash, NEW.payload, NEW.created_at) IS DISTINCT FROM
        ROW(OLD.run_id, OLD.receipt_hash, OLD.payload, OLD.created_at) THEN
        RAISE EXCEPTION 'research receipt is immutable except its first expense verification';
      END IF;
      RETURN NEW;
    END;
  $$`
  yield* sql`CREATE TRIGGER research_inference_receipts_verify_once BEFORE INSERT OR UPDATE ON research_inference_receipts
    FOR EACH ROW EXECUTE FUNCTION verify_research_expense_once()`
  yield* sql`CREATE TRIGGER research_inference_runs_immutable BEFORE UPDATE OR DELETE ON research_inference_runs
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER research_inference_runs_reject_truncate BEFORE TRUNCATE ON research_inference_runs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER research_inference_receipts_reject_delete BEFORE DELETE ON research_inference_receipts
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER research_inference_receipts_reject_truncate BEFORE TRUNCATE ON research_inference_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
