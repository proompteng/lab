import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE lifecycle_commands
    ADD COLUMN not_due_reason text
      CHECK (not_due_reason IN ('MONTH_END_CADENCE', 'STALE_PAPER_BOOTSTRAP')),
    ADD CONSTRAINT lifecycle_commands_not_due_reason_shape CHECK (
      not_due_reason IS NULL
      OR (status = 'COMPLETED' AND result = 'SUCCESS' AND outcome = 'NOT_DUE')
    )
  `

  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_lifecycle_command_transition()
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
        'status', 'result', 'outcome', 'operation', 'failure', 'message', 'observed_at', 'cadence_decision',
        'not_due_reason', 'completed_at'
      ]) <> (to_jsonb(NEW) - ARRAY[
        'status', 'result', 'outcome', 'operation', 'failure', 'message', 'observed_at', 'cadence_decision',
        'not_due_reason', 'completed_at'
      ]) THEN
        RAISE EXCEPTION 'lifecycle command identity is immutable' USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `
})
