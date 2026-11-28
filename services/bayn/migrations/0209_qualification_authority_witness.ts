import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE OR REPLACE FUNCTION capture_operational_safety_baseline() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    DECLARE witness jsonb;
    BEGIN
      IF NEW.program = 'BAYN_OPERATIONAL_RELIABILITY' THEN
        SELECT to_jsonb(a) INTO witness FROM authority_state a WHERE singleton;
      ELSIF NEW.program = 'BAYN_SYSTEM_QUALIFICATION'
        AND NEW.payload_text::jsonb->>'schemaVersion' = 'bayn.system-registration.v5' THEN
        -- Serialize the witness and admission commit with changes to the serving authority.
        SELECT to_jsonb(a) INTO witness FROM authority_state a WHERE singleton FOR SHARE;
      ELSE
        RETURN NEW;
      END IF;
      INSERT INTO operational_safety_baselines(registration_hash, authority_state)
      VALUES (NEW.registration_hash, witness);
      RETURN NEW;
    END
    $function$`
})
