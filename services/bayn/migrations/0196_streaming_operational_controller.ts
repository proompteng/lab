import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // This insert-only guard leaves retained registrations, receipt bytes and history untouched.
  yield* sql`CREATE OR REPLACE FUNCTION check_operational_controller_plan() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF NEW.program='BAYN_OPERATIONAL_RELIABILITY' AND (
      NEW.payload_text::jsonb #>> '{obligations,configuration,controllerPlanHash}'
        IS DISTINCT FROM '97e2dcb93e1a130ac27b6175be48eb937df0ea5dd6f3430bd249fead2f51807b'
      OR NEW.payload_text::jsonb #>> '{obligations,configuration,schemaVersion}'
        IS DISTINCT FROM 'bayn.qualification-runtime.v2'
      OR NEW.payload_text::jsonb #>> '{obligations,configuration,decisionTrigger}'
        IS DISTINCT FROM 'streaming'
    ) THEN
      RAISE EXCEPTION 'operational registration requires the streaming controller and runtime' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END $function$`
})
