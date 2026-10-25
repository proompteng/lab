import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

export default Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`ALTER TABLE positions DROP CONSTRAINT positions_schema_version_check`
  yield* sql`ALTER TABLE positions ADD COLUMN cost_basis_micros numeric(39, 0)`
  yield* sql`
    ALTER TABLE positions ADD CONSTRAINT positions_schema_version_check CHECK (
      (schema_version = 'bayn.paper-position.v1' AND cost_basis_micros IS NULL) OR
      (schema_version = 'bayn.position.v2' AND cost_basis_micros IS NOT NULL AND
       cost_basis_micros BETWEEN -170141183460469231731687303715884105728
                            AND 170141183460469231731687303715884105727)
    )
  `
})
