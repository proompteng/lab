import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE broker_observation_captures (
      account_id text NOT NULL REFERENCES broker_observations (account_id) ON DELETE CASCADE,
      capture_id text NOT NULL,
      generation integer NOT NULL CHECK (generation > 0),
      settled boolean NOT NULL DEFAULT false,
      claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (account_id, capture_id),
      UNIQUE (account_id, generation)
    )
  `
})
