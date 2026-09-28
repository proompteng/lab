import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE autonomous_cycles
      DROP CONSTRAINT autonomous_cycles_entry_attempt_ordinal_check,
      ADD CONSTRAINT autonomous_cycles_entry_attempt_ordinal_check CHECK (
        (
          schema_version = 'bayn.autonomous-cycle.v4'
          AND identity_schema_version = 'bayn.autonomous-cycle-identity.v4'
          AND strategy_name = 'intraday-momentum'
          AND entry_attempt_ordinal > 0
        )
        OR (
          schema_version <> 'bayn.autonomous-cycle.v4'
          AND identity_schema_version <> 'bayn.autonomous-cycle-identity.v4'
          AND entry_attempt_ordinal = 1
        )
      ) NOT VALID
  `
  yield* sql`ALTER TABLE autonomous_cycles VALIDATE CONSTRAINT autonomous_cycles_entry_attempt_ordinal_check`
})
