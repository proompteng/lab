import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE simulated_execution_clocks
    ADD COLUMN source_read_started_at timestamptz,
    ADD CONSTRAINT source_read_requires_measurement CHECK (
      source_read_started_at IS NULL OR measured_at IS NOT NULL
    )`
  yield* sql`
    CREATE OR REPLACE FUNCTION execution_account_commit_now(account text) RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $function$
    DECLARE observed timestamptz; measured timestamptz; source_read_started timestamptz;
    BEGIN
      IF account !~ '^replay-[0-9a-f]{64}$' THEN RETURN clock_timestamp(); END IF;
      SELECT coalesce(measured_observed_at, observed_at), measured_at, source_read_started_at
        INTO observed, measured, source_read_started
        FROM simulated_execution_clocks WHERE account_id = account;
      IF NOT FOUND THEN RAISE EXCEPTION 'simulation account has no execution clock' USING ERRCODE = '23514'; END IF;
      IF measured IS NULL THEN RETURN observed; END IF;
      RETURN observed + greatest(interval '0 seconds', coalesce(source_read_started, clock_timestamp()) - measured);
    END
    $function$
  `
})
