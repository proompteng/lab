import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

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
        WHEN 'SUBMIT_STARTED' THEN NEW.event_type IN ('SUBMIT_ACCEPTED', 'SUBMIT_REJECTED', 'SUBMIT_UNKNOWN')
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
