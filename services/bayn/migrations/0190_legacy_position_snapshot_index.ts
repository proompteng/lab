import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [settings] = yield* sql`SELECT current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Struct({ statement_timeout: Schema.String, lock_timeout: Schema.String })]),
      ),
    ),
  )
  // The migrator owns the transaction. Abort a slow build rather than hold its write-conflicting lock
  // for the outer migration deadline; retain any already stricter session limit.
  yield* sql`SELECT set_config(name,
      least(nullif(setting::integer, 0), CASE name WHEN 'statement_timeout' THEN 5000 ELSE 1000 END)::text,
      true)
    FROM pg_settings WHERE name IN ('statement_timeout', 'lock_timeout')`
  yield* sql`CREATE INDEX position_snapshots_legacy_account_observed_at_idx
    ON position_snapshots (account_id, observed_at DESC)
    WHERE NOT ingestion_order_trusted`
  yield* sql`SELECT set_config('statement_timeout', ${settings.statement_timeout}, true),
    set_config('lock_timeout', ${settings.lock_timeout}, true)`
})
