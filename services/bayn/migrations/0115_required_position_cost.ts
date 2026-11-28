import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`ALTER TABLE positions DROP CONSTRAINT positions_schema_version_check`
  // Historical observations stay immutable; every new write must carry the current cost contract.
  yield* sql`ALTER TABLE positions ADD CONSTRAINT positions_schema_version_check CHECK (
    schema_version = 'bayn.position.v2' AND cost_basis_micros IS NOT NULL AND
    cost_basis_micros BETWEEN -170141183460469231731687303715884105728
                         AND 170141183460469231731687303715884105727
  ) NOT VALID`
})
