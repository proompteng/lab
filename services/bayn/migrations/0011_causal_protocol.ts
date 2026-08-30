import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE protocol_locks
    DROP CONSTRAINT protocol_locks_schema_version_check
  `

  yield* sql`
    ALTER TABLE protocol_locks
    ADD CONSTRAINT protocol_locks_schema_version_check
    CHECK (
      schema_version IN (
        'bayn.risk-balanced-trend.protocol.v2',
        'bayn.risk-balanced-trend.protocol.v3'
      )
    )
  `
})
