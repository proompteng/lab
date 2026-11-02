import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE broker_observations
      ADD COLUMN next_poll_not_before timestamptz NOT NULL DEFAULT 'epoch'::timestamptz,
      ADD COLUMN quota_generation bigint
  `
})
