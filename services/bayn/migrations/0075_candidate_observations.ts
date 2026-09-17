import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE intraday_candidate_observations (
      content_hash text PRIMARY KEY CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      cycle_id text NOT NULL REFERENCES autonomous_cycles (cycle_id),
      observed_at timestamptz NOT NULL,
      payload jsonb NOT NULL CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.intraday-candidate-observation.v2'
        AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
        AND payload->>'observedAt' IS NOT NULL
        AND (payload->>'observedAt')::timestamptz = observed_at
      )
    )
  `
  yield* sql`CREATE INDEX intraday_candidate_observations_cycle_time ON intraday_candidate_observations (cycle_id, observed_at)`
  yield* sql`CREATE TRIGGER intraday_candidate_observations_immutable
    BEFORE UPDATE OR DELETE ON intraday_candidate_observations
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER intraday_candidate_observations_reject_truncate
    BEFORE TRUNCATE ON intraday_candidate_observations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
