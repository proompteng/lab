import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE system_qualification_registrations
    DROP CONSTRAINT system_qualification_registrations_check2,
    ADD CONSTRAINT system_registration_payload_shape CHECK (jsonb_typeof(payload_text::jsonb) = 'object'
      AND payload_text::jsonb->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.system-registration.v2'
      AND jsonb_typeof(payload_text::jsonb->'costAllocationPlans') IS NOT DISTINCT FROM 'array'
      AND payload_text::jsonb->>'environment' IS NOT DISTINCT FROM 'PAPER'
      AND payload_text::jsonb->>'program' IS NOT DISTINCT FROM program
      AND (payload_text::jsonb->>'attemptIndex')::integer IS NOT DISTINCT FROM attempt_index
      AND payload_text::jsonb->>'priorAttemptHash' IS NOT DISTINCT FROM prior_attempt_hash
      AND (payload_text::jsonb->>'registeredAt')::timestamptz IS NOT DISTINCT FROM registered_at
      AND (payload_text::jsonb #>> '{calendar,sessions,0,openAt}')::timestamptz IS NOT DISTINCT FROM first_open_at
      AND (payload_text::jsonb #>> '{calendar,sessions,-1,closeAt}')::timestamptz IS NOT DISTINCT FROM last_close_at
      AND jsonb_array_length(payload_text::jsonb #> '{calendar,sessions}') > 0
      AND jsonb_array_length(payload_text::jsonb->'policies') IS NOT DISTINCT FROM 4)`
})
