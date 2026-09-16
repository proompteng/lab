import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE broker_fee_accounting (
      account_id text NOT NULL,
      activity_id text NOT NULL,
      fee_date date NOT NULL,
      net_amount_micros numeric(39,0) NOT NULL,
      data jsonb NOT NULL,
      read_evidence jsonb NOT NULL,
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      ledger_plan_hash text NOT NULL CHECK (ledger_plan_hash ~ '^[0-9a-f]{64}$'),
      tigerbeetle_cluster_id numeric(39,0) NOT NULL,
      tigerbeetle_ledger bigint NOT NULL,
      first_observed_at timestamptz NOT NULL,
      posted_at timestamptz,
      PRIMARY KEY(account_id,activity_id),
      CHECK (data->>'accountId' = account_id AND data->>'activityId' = activity_id
        AND data->>'date' = fee_date::text AND data->>'netAmountMicros' = net_amount_micros::text)
    )
  `
})
