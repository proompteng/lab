import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE broker_observations (
      account_id text PRIMARY KEY,
      source_revision text NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
      generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
      available boolean NOT NULL DEFAULT false,
      poll_started_at timestamptz,
      observed_at timestamptz,
      completed_at timestamptz,
      snapshot_hash text CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
      payload jsonb,
      CHECK (NOT available OR (payload IS NOT NULL AND snapshot_hash IS NOT NULL
        AND observed_at IS NOT NULL AND completed_at IS NOT NULL AND poll_started_at IS NOT NULL))
    )
  `
})
