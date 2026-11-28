import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE jev_evaluation_requests
    ADD COLUMN schema_version text GENERATED ALWAYS AS (payload->>'schemaVersion') STORED NOT NULL`
})
