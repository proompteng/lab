import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE position_snapshots
    ADD COLUMN ingestion_sequence bigint GENERATED ALWAYS AS IDENTITY
  `
  yield* sql`
    CREATE UNIQUE INDEX position_snapshots_ingestion_sequence_idx
    ON position_snapshots (ingestion_sequence)
  `
})
