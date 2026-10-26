import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE jev_evaluation_requests ADD COLUMN expense_stage_count smallint
    GENERATED ALWAYS AS (CASE WHEN payload->>'schemaVersion' = 'bayn.jev-evaluation-request.v2' THEN 2 ELSE 1 END) STORED`
  yield* sql`ALTER TABLE jev_evaluation_receipts ADD COLUMN not_dispatched boolean
    GENERATED ALWAYS AS (COALESCE(payload #>> '{outcome,failure}' = 'NOT_DISPATCHED', false)) STORED`
  yield* sql`ALTER TABLE jev_inference_handoffs ADD COLUMN jev_not_requested boolean
    GENERATED ALWAYS AS (payload #>> '{disposition,status}' <> 'READY') STORED`
})
