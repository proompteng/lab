import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE intents
      ADD COLUMN replan_generation_hash text CHECK (
        replan_generation_hash ~ '^[0-9a-f]{64}$'
      )
  `

  yield* sql`
    ALTER TABLE intents
      DROP CONSTRAINT intents_decision_target_unique
  `

  yield* sql`
    CREATE UNIQUE INDEX intents_decision_target_generation_unique
      ON intents (
        account_id,
        strategy_name,
        cycle_id,
        decision_hash,
        symbol,
        (COALESCE(replan_generation_hash, ''))
      )
  `
})
