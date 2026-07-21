import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE qualification_locks
      DROP CONSTRAINT qualification_locks_schema_version_check,
      ADD CONSTRAINT qualification_locks_schema_version_check
        CHECK (schema_version IN ('bayn.qualification-lock.v2', 'bayn.qualification-lock.v3'))
  `
})
