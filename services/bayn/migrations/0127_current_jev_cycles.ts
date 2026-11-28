import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`LOCK TABLE autonomous_cycles IN ACCESS EXCLUSIVE MODE`
  yield* sql`DO $cutover$ BEGIN
    IF EXISTS (
      SELECT 1 FROM autonomous_cycles
      WHERE (schema_version IS DISTINCT FROM 'bayn.autonomous-cycle.v4'
        OR identity_schema_version IS DISTINCT FROM 'bayn.autonomous-cycle-identity.v4'
        OR strategy_name IS DISTINCT FROM 'jev'
        OR execution_policy_schema_version IS DISTINCT FROM 'bayn.autonomous-cycle-execution-policy.v3'
        OR window_schema_version IS DISTINCT FROM 'bayn.autonomous-cycle-window.v3')
        AND state NOT IN ('COMPLETED', 'NO_TRADE', 'BLOCKED')
    ) THEN RAISE EXCEPTION 'current Jev cycle cutover requires every retired cycle to be terminal' USING ERRCODE = '55000';
    END IF;
  END $cutover$`
  yield* sql`ALTER TABLE autonomous_cycles ADD CONSTRAINT autonomous_cycles_current_jev_write CHECK (
    schema_version = 'bayn.autonomous-cycle.v4'
    AND identity_schema_version = 'bayn.autonomous-cycle-identity.v4'
    AND strategy_name = 'jev'
    AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v3'
    AND window_schema_version = 'bayn.autonomous-cycle-window.v3'
  ) NOT VALID`
})
