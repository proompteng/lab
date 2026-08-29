import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE INDEX position_snapshots_account_observed_at_idx
    ON position_snapshots (account_id, observed_at DESC)
  `

  yield* sql`
    CREATE INDEX position_snapshots_account_ingestion_sequence_idx
    ON position_snapshots (account_id, ingestion_sequence DESC)
    WHERE ingestion_order_trusted
  `

  yield* sql`
    CREATE INDEX broker_events_account_snapshot_order_idx
    ON broker_events (account_id, source_sequence DESC, observed_at DESC, event_id DESC)
    WHERE event_kind = 'ACCOUNT'
  `

  yield* sql`
    CREATE INDEX intents_account_cycle_idx
    ON intents (account_id, cycle_id)
  `

  yield* sql`
    CREATE INDEX orders_account_intent_idx
    ON orders (account_id, intent_id)
  `

  yield* sql`
    CREATE INDEX fills_account_intent_idx
    ON fills (account_id, intent_id)
  `
})
