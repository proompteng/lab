import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE execution_controller_status DROP CONSTRAINT execution_controller_status_last_outcome_check`
  yield* sql`ALTER TABLE execution_controller_status
    ADD CONSTRAINT execution_controller_status_last_outcome_check
    CHECK (last_outcome IN ('Completed', 'Blocked', 'Waiting'))`
})
