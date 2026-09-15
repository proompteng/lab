import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_intent_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      decision_outcome text;
      decision_decided_at timestamptz;
      decision_expires_at timestamptz;
      decision_checked_at timestamptz;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'intents cannot be deleted' USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'PLANNED'
          OR NEW.risk_decision_id IS NOT NULL
          OR NEW.terminal_outcome IS NOT NULL
          OR NEW.state_version <> 1
          OR NEW.updated_at <> NEW.created_at
        THEN
          RAISE EXCEPTION 'new intents must begin in PLANNED state' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF (to_jsonb(OLD) - ARRAY['state', 'risk_decision_id', 'terminal_outcome', 'state_version', 'updated_at'])
        <> (to_jsonb(NEW) - ARRAY['state', 'risk_decision_id', 'terminal_outcome', 'state_version', 'updated_at'])
      THEN
        RAISE EXCEPTION 'intent immutable fields cannot change' USING ERRCODE = '55000';
      END IF;

      IF NEW.state_version <> OLD.state_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'intent state version and time must advance' USING ERRCODE = '23514';
      END IF;

      IF OLD.state <> 'PLANNED' AND NEW.risk_decision_id IS DISTINCT FROM OLD.risk_decision_id THEN
        RAISE EXCEPTION 'intent risk decision cannot change after planning' USING ERRCODE = '55000';
      END IF;

      IF NOT (CASE OLD.state
        WHEN 'PLANNED' THEN NEW.state IN ('APPROVED', 'TERMINAL')
        WHEN 'APPROVED' THEN NEW.state IN ('IO_STARTED', 'TERMINAL')
        WHEN 'IO_STARTED' THEN NEW.state IN ('ACKNOWLEDGED', 'UNKNOWN', 'TERMINAL')
        WHEN 'ACKNOWLEDGED' THEN NEW.state = 'TERMINAL'
        WHEN 'UNKNOWN' THEN NEW.state = 'RECOVERED'
        WHEN 'RECOVERED' THEN NEW.state IN ('ACKNOWLEDGED', 'TERMINAL')
        WHEN 'TERMINAL' THEN false
        ELSE false
      END) THEN
        RAISE EXCEPTION 'invalid intent transition from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
      END IF;

      IF NEW.state = 'TERMINAL' AND NOT (CASE OLD.state
        WHEN 'PLANNED' THEN NEW.terminal_outcome = 'BLOCKED'
        WHEN 'APPROVED' THEN NEW.terminal_outcome IN ('BLOCKED', 'CANCELED')
        WHEN 'IO_STARTED' THEN NEW.terminal_outcome IN ('FILLED', 'CANCELED', 'EXPIRED', 'REJECTED')
        WHEN 'ACKNOWLEDGED' THEN NEW.terminal_outcome IN ('FILLED', 'CANCELED', 'EXPIRED', 'REJECTED')
        WHEN 'RECOVERED' THEN NEW.terminal_outcome IN ('FILLED', 'CANCELED', 'EXPIRED', 'REJECTED')
        ELSE false
      END) THEN
        RAISE EXCEPTION 'invalid terminal outcome % from %', NEW.terminal_outcome, OLD.state USING ERRCODE = '23514';
      END IF;

      IF OLD.state = 'PLANNED' OR NEW.state = 'IO_STARTED' THEN
        SELECT outcome, decided_at, expires_at
        INTO decision_outcome, decision_decided_at, decision_expires_at
        FROM risk_decisions
        WHERE decision_id = NEW.risk_decision_id AND intent_id = NEW.intent_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'intent transition requires its bound risk decision' USING ERRCODE = '23503';
        END IF;

        decision_checked_at := clock_timestamp();
        IF decision_decided_at > NEW.updated_at
          OR decision_expires_at <= NEW.updated_at
          OR decision_decided_at > decision_checked_at
          OR decision_expires_at <= decision_checked_at
        THEN
          RAISE EXCEPTION 'intent transition requires a current risk decision' USING ERRCODE = '23514';
        END IF;

        IF NEW.state = 'TERMINAL' AND decision_outcome <> 'BLOCKED' THEN
          RAISE EXCEPTION 'blocked terminal intent requires a blocked risk decision' USING ERRCODE = '23514';
        END IF;

        IF NEW.state <> 'TERMINAL' AND decision_outcome <> 'APPROVED' THEN
          RAISE EXCEPTION 'broker I/O requires an approved risk decision' USING ERRCODE = '23514';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `
})
