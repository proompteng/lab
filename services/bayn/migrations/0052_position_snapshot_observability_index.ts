import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE INDEX position_snapshots_account_observed_at_idx
    ON position_snapshots (account_id, observed_at DESC)
  `
})
