import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Existing registrations and receipts retain their original missing binding and measured failures.
  yield* sql`CREATE FUNCTION check_operational_controller_plan() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF NEW.program='BAYN_OPERATIONAL_RELIABILITY'
      AND NEW.payload_text::jsonb #>> '{obligations,configuration,controllerPlanHash}'
        IS DISTINCT FROM '0c2f682a50bbd17fc1d780fbdb48f1dd588932f8f771474ecdce272091aaadcc' THEN
      RAISE EXCEPTION 'operational registration requires the native controller plan' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER operational_controller_plan BEFORE INSERT ON system_qualification_registrations
    FOR EACH ROW EXECUTE FUNCTION check_operational_controller_plan()`
})
