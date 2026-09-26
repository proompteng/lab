import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE jev_batch_plans
      DROP CONSTRAINT jev_batch_plans_check,
      ADD CONSTRAINT jev_batch_plans_check CHECK (
        jsonb_typeof(payload) = 'object'
        AND (payload->>'schemaVersion' IN ('bayn.jev-batch-plan.v1', 'bayn.jev-batch-plan.v2', 'bayn.jev-batch-plan.v3')) IS TRUE
        AND payload->>'batchId' IS NOT DISTINCT FROM batch_id
        AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
        AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
        AND payload->>'observationHash' IS NOT DISTINCT FROM observation_hash
      )
  `
})
