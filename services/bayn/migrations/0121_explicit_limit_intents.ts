import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`DO $cutover$
    BEGIN
      IF EXISTS (SELECT 1 FROM intents WHERE state <> 'TERMINAL') OR EXISTS (
        SELECT 1 FROM autonomous_cycles WHERE terminal_at IS NULL AND decision_hash IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (intent_id, operation) event_type
          FROM mutation_events
          ORDER BY intent_id, operation, sequence DESC
        ) latest
        WHERE event_type IN ('SUBMIT_STARTED', 'SUBMIT_UNKNOWN', 'CANCEL_STARTED', 'CANCEL_UNKNOWN', 'RECOVERY_UNKNOWN')
      ) THEN
        RAISE EXCEPTION 'explicit LIMIT cutover requires terminal intents, settled bound cycles and resolved broker mutations'
          USING ERRCODE = '55000';
      END IF;
    END $cutover$`
  yield* sql`ALTER TABLE intents
    ADD COLUMN limit_price_micros numeric(39,0),
    DROP CONSTRAINT intents_schema_version_check,
    ADD CONSTRAINT intents_schema_version_check
      CHECK (schema_version = 'bayn.execution-intent.v4') NOT VALID,
    ADD CONSTRAINT intents_explicit_limit_terms_check CHECK (
      order_type = 'LIMIT' AND limit_price_micros IS NOT NULL AND limit_price_micros > 0
      AND limit_price_micros <= 340282366920938463463374607431768211455
      AND time_in_force = CASE WHEN position('/' IN symbol) > 0 THEN 'IOC' ELSE 'DAY' END
      AND notional_limit_micros = CASE WHEN side = 'BUY'
        THEN ceil(quantity_atoms * limit_price_micros / 1000000000)
        ELSE floor(quantity_atoms * limit_price_micros / 1000000000) END
    ) NOT VALID`
})
