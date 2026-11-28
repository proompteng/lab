import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // The serialized controller handoff publishes only its active successor. A changed
  // plan may cross exactly one epoch without moving the sequence or inheriting a pass.
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
      IF NEW.next_sequence < OLD.next_sequence THEN
        RAISE EXCEPTION 'execution controller sequence cannot move backward' USING ERRCODE = '23514';
      END IF;
      IF NEW.plan_hash <> OLD.plan_hash
         AND OLD.plan_hash <> repeat('0', 64)
         AND NOT (
           (
             OLD.active = false
             AND NEW.active = true
             AND NEW.epoch = OLD.epoch
             AND NEW.next_sequence = OLD.next_sequence
           )
           OR (
             OLD.active = true
             AND NEW.active = true
             AND NEW.epoch = OLD.epoch + 1
             AND NEW.next_sequence = OLD.next_sequence
             AND NEW.last_sequence IS NULL
             AND NEW.last_outcome IS NULL
             AND NEW.last_receipt_hash IS NULL
             AND NEW.completed_at IS NULL
             AND NEW.next_due_at IS NULL
             AND NEW.last_pass IS NULL
           )
         ) THEN
        RAISE EXCEPTION 'execution controller plan change requires inactive activation or an exact atomic successor'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.active = false
         AND NEW.active = true
         AND NEW.epoch = OLD.epoch
         AND NEW.next_sequence = OLD.next_sequence
         AND (
           NEW.last_sequence IS NOT NULL
           OR NEW.last_outcome IS NOT NULL
           OR NEW.last_receipt_hash IS NOT NULL
           OR NEW.completed_at IS NOT NULL
           OR NEW.next_due_at IS NOT NULL
           OR NEW.last_pass IS NOT NULL
         ) THEN
        RAISE EXCEPTION 'execution controller activation cannot inherit prior completion evidence'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.epoch < OLD.epoch
         OR (
           NEW.epoch = OLD.epoch
           AND (
             NEW.next_sequence < OLD.next_sequence
             OR (
               NEW.next_sequence = OLD.next_sequence
               AND NOT (
                 (OLD.active = false AND NEW.active = true)
                 OR (
                   OLD.plan_hash = repeat('0', 64)
                   AND NEW.plan_hash <> OLD.plan_hash
                   AND OLD.active = true
                   AND NEW.active = true
                   AND NEW.last_sequence IS NOT DISTINCT FROM OLD.last_sequence
                   AND NEW.last_outcome IS NOT DISTINCT FROM OLD.last_outcome
                   AND NEW.last_receipt_hash IS NOT DISTINCT FROM OLD.last_receipt_hash
                   AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
                   AND NEW.next_due_at IS NOT DISTINCT FROM OLD.next_due_at
                   AND NEW.last_pass IS NOT DISTINCT FROM OLD.last_pass
                 )
               )
             )
           )
         ) THEN
        RAISE EXCEPTION 'execution controller status must advance monotonically' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `
})
