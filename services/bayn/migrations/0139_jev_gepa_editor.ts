import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM research_inference_runs run
      WHERE run.payload->>'schemaVersion' IS DISTINCT FROM 'bayn.jev-editor.v1'
        AND (run.payload->>'deadlineAt')::timestamptz > statement_timestamp()
        AND NOT EXISTS (SELECT 1 FROM research_inference_receipts receipt WHERE receipt.run_id = run.run_id)
    ) THEN
      RAISE EXCEPTION 'Let in-flight research registrations finish before the Jev editor hard migration';
    END IF;
    IF EXISTS (
      SELECT 1 FROM research_inference_receipts
      WHERE verified_at IS NULL AND payload->>'costPicoUsd' IS NOT NULL
        AND payload->>'schemaVersion' IS DISTINCT FROM 'bayn.research-receipt.v2'
    ) THEN
      RAISE EXCEPTION 'Settle retained research expenses before the Jev editor hard migration';
    END IF;
  END $$`
  yield* sql`ALTER TABLE research_inference_runs DROP CONSTRAINT research_inference_runs_payload_check`
  yield* sql`ALTER TABLE research_inference_runs ADD CONSTRAINT research_inference_runs_payload_check CHECK (
    payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-editor.v1'
    AND payload->>'purpose' IS NOT DISTINCT FROM 'prompt-edit'
  ) NOT VALID`
  yield* sql`ALTER TABLE research_inference_receipts DROP CONSTRAINT research_inference_receipts_check`
  yield* sql`ALTER TABLE research_inference_receipts ADD CONSTRAINT research_inference_receipts_check CHECK (
    payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.research-receipt.v2'
    AND payload->>'runId' IS NOT DISTINCT FROM run_id
    AND payload->>'receiptHash' IS NOT DISTINCT FROM receipt_hash
    AND payload->>'qualification' IS NOT DISTINCT FROM 'UNQUALIFIED'
  ) NOT VALID`
})
