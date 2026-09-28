import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE mutation_events
    DROP CONSTRAINT mutation_events_check1
  `

  yield* sql`
    ALTER TABLE mutation_events
    ADD CONSTRAINT mutation_events_event_contract_check CHECK (
      (event_type = 'SUBMIT_STARTED' AND operation = 'SUBMIT' AND broker_order_id IS NULL AND response_status IS NULL)
      OR (
        event_type = 'SUBMIT_ACCEPTED'
        AND operation = 'SUBMIT'
        AND broker_order_id IS NOT NULL
        AND response_status = 200
      )
      OR (
        event_type = 'SUBMIT_REJECTED'
        AND operation = 'SUBMIT'
        AND broker_order_id IS NULL
        AND response_status IN (400, 401, 403, 404, 422)
      )
      OR (event_type = 'SUBMIT_UNKNOWN' AND operation = 'SUBMIT')
      OR (event_type = 'RECOVERY_FOUND' AND broker_order_id IS NOT NULL AND response_status = 200)
      OR (
        event_type = 'RECOVERY_NOT_FOUND'
        AND response_status = 404
        AND (
          operation = 'SUBMIT'
          OR (operation = 'CANCEL' AND broker_order_id IS NOT NULL)
        )
      )
      OR (event_type = 'RECOVERY_UNKNOWN')
      OR (event_type = 'CANCEL_STARTED' AND operation = 'CANCEL' AND broker_order_id IS NOT NULL AND response_status IS NULL)
      OR (
        event_type = 'CANCEL_ACCEPTED'
        AND operation = 'CANCEL'
        AND broker_order_id IS NOT NULL
        AND response_status = 204
      )
      OR (event_type = 'CANCEL_UNKNOWN' AND operation = 'CANCEL' AND broker_order_id IS NOT NULL)
    )
  `
})
