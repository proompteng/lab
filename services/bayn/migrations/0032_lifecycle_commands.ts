import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE lifecycle_commands (
      controller_key text NOT NULL CHECK (controller_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
      command_id text NOT NULL CHECK (command_id ~ '^[0-9a-f]{64}$'),
      sequence bigint NOT NULL CHECK (sequence > 0),
      issued_at timestamptz NOT NULL,
      status text NOT NULL CHECK (status IN ('STARTED', 'COMPLETED')),
      result text CHECK (result IN ('SUCCESS', 'FAILURE')),
      outcome text,
      operation text,
      failure text,
      message text,
      observed_at timestamptz,
      cadence_decision jsonb,
      started_at timestamptz NOT NULL,
      completed_at timestamptz,
      PRIMARY KEY (controller_key, command_id),
      UNIQUE (controller_key, sequence),
      CHECK (
        (status = 'STARTED'
          AND result IS NULL
          AND outcome IS NULL
          AND operation IS NULL
          AND failure IS NULL
          AND message IS NULL
          AND observed_at IS NULL
          AND cadence_decision IS NULL
          AND completed_at IS NULL)
        OR
        (status = 'COMPLETED'
          AND result IS NOT NULL
          AND observed_at IS NOT NULL
          AND completed_at IS NOT NULL
          AND completed_at >= started_at
          AND (
            (result = 'SUCCESS' AND outcome IS NOT NULL AND operation IS NULL AND failure IS NULL AND message IS NULL)
            OR
            (result = 'FAILURE' AND outcome IS NULL AND operation IS NOT NULL AND failure IS NOT NULL AND message IS NOT NULL)
          ))
      )
    )
  `

  yield* sql`
    CREATE FUNCTION enforce_lifecycle_command_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'lifecycle commands cannot be deleted' USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'STARTED' THEN
          RAISE EXCEPTION 'lifecycle commands must begin in STARTED state' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status <> 'STARTED' OR NEW.status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'lifecycle command may only transition STARTED to COMPLETED' USING ERRCODE = '23514';
      END IF;

      IF (to_jsonb(OLD) - ARRAY[
        'status', 'result', 'outcome', 'operation', 'failure', 'message', 'observed_at', 'cadence_decision', 'completed_at'
      ]) <> (to_jsonb(NEW) - ARRAY[
        'status', 'result', 'outcome', 'operation', 'failure', 'message', 'observed_at', 'cadence_decision', 'completed_at'
      ]) THEN
        RAISE EXCEPTION 'lifecycle command identity is immutable' USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `

  yield* sql`
    CREATE TRIGGER lifecycle_command_transition
    BEFORE INSERT OR UPDATE OR DELETE ON lifecycle_commands
    FOR EACH ROW EXECUTE FUNCTION enforce_lifecycle_command_transition()
  `
})
