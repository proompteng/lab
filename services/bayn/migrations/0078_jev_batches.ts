import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE jev_batch_plans (
      batch_id text PRIMARY KEY CHECK (batch_id ~ '^[0-9a-f]{64}$'),
      cycle_id text NOT NULL REFERENCES autonomous_cycles (cycle_id),
      authority_generation_hash text NOT NULL REFERENCES authority_generations (generation_hash),
      observation_hash text NOT NULL REFERENCES intraday_candidate_observations (content_hash),
      snapshot_id text GENERATED ALWAYS AS (payload->>'snapshotId') STORED NOT NULL
        CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
      payload jsonb NOT NULL CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-batch-plan.v1'
        AND payload->>'batchId' IS NOT DISTINCT FROM batch_id
        AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
        AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
        AND payload->>'observationHash' IS NOT DISTINCT FROM observation_hash
      ),
      UNIQUE (cycle_id, authority_generation_hash, snapshot_id)
    )
  `
  yield* sql`
    CREATE TABLE jev_batch_results (
      batch_id text PRIMARY KEY REFERENCES jev_batch_plans (batch_id),
      result_hash text NOT NULL UNIQUE CHECK (result_hash ~ '^[0-9a-f]{64}$'),
      payload jsonb NOT NULL CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-batch-result.v1'
        AND payload->>'batchId' IS NOT DISTINCT FROM batch_id
        AND payload->>'resultHash' IS NOT DISTINCT FROM result_hash
      )
    )
  `
  yield* sql`CREATE TRIGGER jev_batch_plans_immutable
    BEFORE UPDATE OR DELETE ON jev_batch_plans
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER jev_batch_plans_reject_truncate
    BEFORE TRUNCATE ON jev_batch_plans
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER jev_batch_results_immutable
    BEFORE UPDATE OR DELETE ON jev_batch_results
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER jev_batch_results_reject_truncate
    BEFORE TRUNCATE ON jev_batch_results
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
