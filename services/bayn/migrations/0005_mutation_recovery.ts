import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE mutation_events (
      event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-mutation-event.v1'),
      mutation_id text NOT NULL CHECK (mutation_id ~ '^[0-9a-f]{64}$'),
      intent_id text NOT NULL REFERENCES intents(intent_id) ON DELETE RESTRICT,
      sequence bigint NOT NULL CHECK (sequence > 0),
      operation text NOT NULL CHECK (operation IN ('SUBMIT', 'CANCEL')),
      event_type text NOT NULL CHECK (event_type IN (
        'SUBMIT_STARTED',
        'SUBMIT_ACCEPTED',
        'SUBMIT_REJECTED',
        'SUBMIT_UNKNOWN',
        'RECOVERY_FOUND',
        'RECOVERY_NOT_FOUND',
        'RECOVERY_UNKNOWN',
        'CANCEL_STARTED',
        'CANCEL_ACCEPTED',
        'CANCEL_UNKNOWN'
      )),
      request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      consistency_delay_ms integer NOT NULL CHECK (consistency_delay_ms BETWEEN 1 AND 300000),
      broker_order_id text CHECK (
        length(broker_order_id) > 0 AND broker_order_id = btrim(broker_order_id)
      ),
      request_id text CHECK (length(request_id) > 0 AND request_id = btrim(request_id)),
      response_status smallint CHECK (response_status BETWEEN 100 AND 599),
      response_content_hash text CHECK (response_content_hash ~ '^[0-9a-f]{64}$'),
      occurred_at timestamptz NOT NULL,
      UNIQUE (mutation_id, sequence),
      UNIQUE (intent_id, operation, sequence),
      CHECK (
        (request_id IS NULL AND response_status IS NULL AND response_content_hash IS NULL)
        OR (request_id IS NOT NULL AND response_status IS NOT NULL AND response_content_hash IS NOT NULL)
      ),
      CHECK (
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
        OR (event_type = 'SUBMIT_UNKNOWN' AND operation = 'SUBMIT' AND broker_order_id IS NULL)
        OR (event_type = 'RECOVERY_FOUND' AND broker_order_id IS NOT NULL AND response_status = 200)
        OR (
          event_type = 'RECOVERY_NOT_FOUND'
          AND response_status = 404
          AND (
            (operation = 'SUBMIT' AND broker_order_id IS NULL)
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
    )
  `

  yield* sql`
    CREATE UNIQUE INDEX mutation_events_one_start
    ON mutation_events(intent_id, operation)
    WHERE sequence = 1
  `

  yield* sql`
    CREATE FUNCTION enforce_mutation_event_transition()
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
        WHEN 'SUBMIT_UNKNOWN' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'CANCEL_STARTED' THEN NEW.event_type IN ('CANCEL_ACCEPTED', 'CANCEL_UNKNOWN')
        WHEN 'CANCEL_ACCEPTED' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'CANCEL_UNKNOWN' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'RECOVERY_NOT_FOUND' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'RECOVERY_UNKNOWN' THEN NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        WHEN 'RECOVERY_FOUND' THEN
          previous.operation = 'CANCEL'
          AND NEW.event_type IN ('RECOVERY_FOUND', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN')
        ELSE false
      END) THEN
        RAISE EXCEPTION 'invalid mutation transition from % to %', previous.event_type, NEW.event_type
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `

  yield* sql`
    CREATE TRIGGER mutation_event_transition_only
    BEFORE INSERT ON mutation_events
    FOR EACH ROW EXECUTE FUNCTION enforce_mutation_event_transition()
  `
  yield* sql`
    CREATE TRIGGER mutation_events_append_only
    BEFORE UPDATE OR DELETE ON mutation_events
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER mutation_events_reject_truncate
    BEFORE TRUNCATE ON mutation_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
})
