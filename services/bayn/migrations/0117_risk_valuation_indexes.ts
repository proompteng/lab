import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Match the New York accounting date and deterministic opening-mark order exactly.
  yield* sql`
    CREATE INDEX valuations_account_session_open_idx
    ON valuations (account_id, ((as_of AT TIME ZONE 'America/New_York')::date), as_of, valuation_id COLLATE "C")
    INCLUDE (equity_micros)
  `
  // The original observation cutoff still excludes future marks from the peak.
  yield* sql`
    CREATE INDEX valuations_account_peak_idx
    ON valuations (account_id, equity_micros DESC, as_of)
  `
})
