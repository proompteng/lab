import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX jev_evaluation_requests_authority_cycle
    ON jev_evaluation_requests (authority_generation_hash, cycle_id)`
})
