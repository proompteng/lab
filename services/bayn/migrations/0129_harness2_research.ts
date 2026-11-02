import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE research_inference_runs DROP CONSTRAINT research_inference_runs_payload_check`
  yield* sql`ALTER TABLE research_inference_runs ADD CONSTRAINT research_inference_runs_payload_check CHECK (
    payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.research-run.v1'
    OR (
      payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.harness2-inference.v1'
      AND (payload->>'purpose' IN ('prompt-edit', 'reflection')) IS TRUE
    )
  )`
})
