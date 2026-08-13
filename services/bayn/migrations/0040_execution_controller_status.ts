import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE execution_controller_status (
      controller_key text PRIMARY KEY CHECK (controller_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
      epoch bigint NOT NULL CHECK (epoch BETWEEN 0 AND 9007199254740991),
      last_sequence bigint NOT NULL CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
      last_outcome text NOT NULL CHECK (last_outcome IN ('Completed', 'Blocked')),
      last_receipt_hash text NOT NULL CHECK (last_receipt_hash ~ '^[0-9a-f]{64}$'),
      completed_at timestamptz NOT NULL,
      next_due_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `

  yield* sql`
    CREATE FUNCTION enforce_execution_controller_status_transition()
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
      IF NEW.epoch < OLD.epoch OR (NEW.epoch = OLD.epoch AND NEW.last_sequence <= OLD.last_sequence) THEN
        RAISE EXCEPTION 'execution controller status must advance monotonically' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `

  yield* sql`
    CREATE TRIGGER execution_controller_status_transition
    BEFORE INSERT OR UPDATE OR DELETE ON execution_controller_status
    FOR EACH ROW EXECUTE FUNCTION enforce_execution_controller_status_transition()
  `
})
