import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE execution_controller_status
    ADD COLUMN plan_hash text DEFAULT repeat('0', 64) CHECK (plan_hash ~ '^[0-9a-f]{64}$')
  `

  // Migration 40 could have projected a controller completion before this
  // deployment. Reserve the all-zero hash as an explicitly unbound legacy
  // value; the first monotonic projection from the durable controller binds it.
  yield* sql`
    UPDATE execution_controller_status
    SET plan_hash = repeat('0', 64)
    WHERE plan_hash IS NULL
  `

  yield* sql`
    ALTER TABLE execution_controller_status
    ALTER COLUMN plan_hash SET NOT NULL
  `

  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_execution_controller_status_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'execution controller status cannot be deleted' USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'INSERT' THEN
        RETURN NEW;
      END IF;
      IF NEW.controller_key <> OLD.controller_key THEN
        RAISE EXCEPTION 'execution controller identity is immutable' USING ERRCODE = '55000';
      END IF;
      IF NEW.plan_hash <> OLD.plan_hash
         AND OLD.plan_hash <> repeat('0', 64)
         AND NOT (OLD.active = false AND NEW.active = true AND NEW.epoch = OLD.epoch) THEN
        RAISE EXCEPTION 'execution controller plan can change only while activating an inactive epoch'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.epoch < OLD.epoch OR (NEW.epoch = OLD.epoch AND NEW.last_sequence <= OLD.last_sequence) THEN
        RAISE EXCEPTION 'execution controller status must advance monotonically' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `
})
