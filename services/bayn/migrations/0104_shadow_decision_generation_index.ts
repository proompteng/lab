import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE INDEX autonomous_cycle_shadow_decisions_generation_idx
    ON autonomous_cycle_shadow_decisions ((document #>> '{bindings,authorityGenerationHash}'))
  `
})
