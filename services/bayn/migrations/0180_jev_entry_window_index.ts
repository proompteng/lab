import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX intraday_candidate_observations_jev_entry_window
    ON intraday_candidate_observations (
      (payload #>> '{portfolio,purpose}'), (payload #>> '{manifest,rangeEndAt}') DESC, cycle_id
    ) WHERE payload ->> 'schemaVersion' = 'bayn.jev-observation.v1'`
})
