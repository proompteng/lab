import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM fills) THEN
        RAISE EXCEPTION 'fill source timestamp migration requires an empty fills table';
      END IF;
    END
    $$
  `

  yield* sql`
    ALTER TABLE fills
    ADD COLUMN source_timestamp text NOT NULL CHECK (
      source_timestamp ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$'
    )
  `

  yield* sql`
    CREATE INDEX fills_account_source_order_idx
    ON fills(account_id, symbol, source_timestamp COLLATE "C", fill_id COLLATE "C")
  `
})
