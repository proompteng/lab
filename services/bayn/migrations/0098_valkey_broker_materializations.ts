import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE broker_observations ADD COLUMN state_hash text CHECK (state_hash ~ '^[0-9a-f]{64}$')`
  yield* sql`UPDATE broker_observations SET available = false, generation = generation + 1, snapshot_hash = NULL`
  yield* sql`ALTER TABLE broker_observations DROP COLUMN payload`
  yield* sql`ALTER TABLE broker_observations ADD CONSTRAINT broker_observations_materialized_check
    CHECK (NOT available OR (snapshot_hash IS NOT NULL AND state_hash IS NOT NULL
      AND observed_at IS NOT NULL AND completed_at IS NOT NULL AND poll_started_at IS NOT NULL))`
})
