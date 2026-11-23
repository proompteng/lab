import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE reconciliations
      ADD COLUMN account_event_id text,
      ADD COLUMN position_snapshot_id text,
      ADD CONSTRAINT reconciliation_snapshot_pair CHECK (
        (account_event_id IS NULL) = (position_snapshot_id IS NULL)
      ) NOT VALID,
      ADD CONSTRAINT reconciliation_account_snapshot_fk FOREIGN KEY (account_event_id)
        REFERENCES account_snapshots(event_id) ON DELETE RESTRICT NOT VALID,
      ADD CONSTRAINT reconciliation_position_snapshot_fk FOREIGN KEY (position_snapshot_id, account_id)
        REFERENCES position_snapshots(snapshot_id, account_id) ON DELETE RESTRICT NOT VALID
  `
})
