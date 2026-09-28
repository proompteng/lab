import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE mutation_events
    DROP CONSTRAINT mutation_events_event_type_check
  `

  yield* sql`
    ALTER TABLE mutation_events
    ADD CONSTRAINT mutation_events_event_type_check CHECK (event_type IN (
      'SUBMIT_STARTED',
      'SUBMIT_ACCEPTED',
      'SUBMIT_REJECTED',
      'SUBMIT_DENIED',
      'SUBMIT_UNKNOWN',
      'RECOVERY_FOUND',
      'RECOVERY_NOT_FOUND',
      'RECOVERY_UNKNOWN',
      'CANCEL_STARTED',
      'CANCEL_ACCEPTED',
      'CANCEL_UNKNOWN'
    ))
  `

  yield* sql`
    ALTER TABLE mutation_events
    DROP CONSTRAINT mutation_events_event_contract_check
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
      OR (
        event_type = 'SUBMIT_DENIED'
        AND operation = 'SUBMIT'
        AND broker_order_id IS NULL
        AND response_status IS NULL
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

  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_mutation_event_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      previous mutation_events%ROWTYPE;
    BEGIN
      SELECT * INTO previous
      FROM mutation_events
      WHERE mutation_id = NEW.mutation_id
      ORDER BY sequence DESC
      LIMIT 1
      FOR UPDATE;

      IF NOT FOUND THEN
        IF NEW.sequence <> 1 OR NEW.event_type NOT IN ('SUBMIT_STARTED', 'CANCEL_STARTED') THEN
          RAISE EXCEPTION 'mutation must begin with its STARTED event' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.sequence <> previous.sequence + 1
        OR NEW.intent_id <> previous.intent_id
        OR NEW.operation <> previous.operation
        OR NEW.request_hash <> previous.request_hash
        OR NEW.consistency_delay_ms <> previous.consistency_delay_ms
        OR NEW.occurred_at < previous.occurred_at
      THEN
        RAISE EXCEPTION 'mutation identity and sequence must remain exact' USING ERRCODE = '23514';
      END IF;

      IF previous.broker_order_id IS NOT NULL
        AND NEW.broker_order_id IS DISTINCT FROM previous.broker_order_id
      THEN
        RAISE EXCEPTION 'mutation broker order identity cannot change' USING ERRCODE = '23514';
      END IF;

      IF NOT (CASE previous.event_type
        WHEN 'SUBMIT_STARTED' THEN
          NEW.event_type IN ('SUBMIT_ACCEPTED', 'SUBMIT_REJECTED', 'SUBMIT_DENIED', 'SUBMIT_UNKNOWN')
        WHEN 'SUBMIT_ACCEPTED' THEN
          previous.operation = 'SUBMIT'
          AND NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'SUBMIT_UNKNOWN' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'CANCEL_STARTED' THEN NEW.event_type IN ('CANCEL_ACCEPTED', 'CANCEL_UNKNOWN')
        WHEN 'CANCEL_ACCEPTED' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'CANCEL_UNKNOWN' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'RECOVERY_NOT_FOUND' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'RECOVERY_UNKNOWN' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'RECOVERY_FOUND' THEN
          NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        ELSE false
      END) THEN
        RAISE EXCEPTION 'invalid mutation transition from % to %', previous.event_type, NEW.event_type
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `
})
