import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE bayn_evaluation_events
      DROP CONSTRAINT bayn_evaluation_events_event_kind_check
  `
  yield* sql`
    ALTER TABLE bayn_evaluation_events
      ADD CONSTRAINT bayn_evaluation_events_event_kind_check
      CHECK (event_kind IN ('decision', 'fill', 'fee', 'cash-yield'))
  `
})
