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
        WHEN 'APPROVED' THEN NEW.terminal_outcome IN ('BLOCKED', 'CANCELED', 'EXPIRED')
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

  yield* sql`
    CREATE OR REPLACE FUNCTION research_paper_rearm_eligible(
      candidate_generation_hash text,
      candidate_authority_version bigint,
      candidate_activated_at timestamptz
    )
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      SELECT EXISTS (
        SELECT 1
        FROM authority_state AS state
        JOIN authority_generations AS previous_generation
          ON previous_generation.generation_hash = state.generation_hash
        JOIN authority_generations AS candidate_generation
          ON candidate_generation.generation_hash = candidate_generation_hash
        JOIN LATERAL (
          SELECT reconciliation.*
          FROM reconciliations AS reconciliation
          WHERE reconciliation.account_id = previous_generation.account_id
          ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
          LIMIT 1
        ) AS reconciliation ON true
        WHERE state.singleton
          AND (
            (
              state.maximum = 'PAPER'
              AND state.effective = 'OBSERVE'
              AND state.kill_state = 'ACTIVE'
              AND state.reason LIKE 'PAPER autonomous cycle loop restricted effective authority:%'
            )
            OR (
              state.maximum = 'PAPER'
              AND state.effective = 'PAPER'
              AND state.kill_state = 'CLEAR'
              AND state.reason IS NULL
            )
          )
          AND state.version + 1 = candidate_authority_version
          AND previous_generation.maximum = 'PAPER'
          AND previous_generation.activation_schema_version IN (
            'bayn.paper-authority-generation.v2',
            'bayn.paper-authority-generation.v3'
          )
          AND CASE previous_generation.activation_schema_version
            WHEN 'bayn.paper-authority-generation.v2' THEN previous_generation.qualification_run_id IS NOT NULL
            WHEN 'bayn.paper-authority-generation.v3' THEN previous_generation.proof_plan_hash IS NOT NULL
            ELSE false
          END
          AND candidate_generation.previous_generation_hash = previous_generation.generation_hash
          AND candidate_generation.maximum = 'OBSERVE'
          AND candidate_generation.activation_schema_version IS NULL
          AND candidate_generation.authority_version = candidate_authority_version
          AND candidate_generation.activated_at = candidate_activated_at
          AND candidate_generation.broker_identity_schema_version = previous_generation.broker_identity_schema_version
          AND candidate_generation.broker_identity_hash = previous_generation.broker_identity_hash
          AND candidate_generation.broker_provider = previous_generation.broker_provider
          AND candidate_generation.broker_environment = 'sandbox'
          AND candidate_generation.broker_environment = previous_generation.broker_environment
          AND candidate_generation.account_id = previous_generation.account_id
          AND reconciliation.status = 'EXACT'
          AND reconciliation.expected_hash = reconciliation.observed_hash
          AND jsonb_array_length(reconciliation.discrepancies) = 0
          AND reconciliation.reconciled_at > state.updated_at
          AND reconciliation.reconciled_at < candidate_activated_at
          AND NOT EXISTS (
            SELECT 1
            FROM autonomous_cycles AS cycle
            WHERE cycle.qualification_run_id = CASE previous_generation.activation_schema_version
                WHEN 'bayn.paper-authority-generation.v2' THEN previous_generation.qualification_run_id
                WHEN 'bayn.paper-authority-generation.v3' THEN previous_generation.proof_plan_hash
                ELSE NULL
              END
              AND cycle.account_id = previous_generation.account_id
              AND cycle.state IN ('PENDING', 'ACTIVE')
          )
          AND (
            NOT EXISTS (
              SELECT 1
              FROM intents AS intent
              WHERE intent.authority_generation_hash = previous_generation.generation_hash
            )
            OR (
              EXISTS (
                SELECT 1
                FROM intents AS intent
                WHERE intent.authority_generation_hash = previous_generation.generation_hash
              )
              AND NOT EXISTS (
                SELECT 1
                FROM intents AS intent
                WHERE intent.authority_generation_hash = previous_generation.generation_hash
                  AND intent.state <> 'TERMINAL'
              )
              AND NOT paper_account_has_unresolved_mutation(
                previous_generation.account_id,
                reconciliation.reconciled_at
              )
              AND reconciliation.reconciled_at > COALESCE(
                (
                  SELECT max(intent.updated_at)
                  FROM intents AS intent
                  WHERE intent.authority_generation_hash = previous_generation.generation_hash
                ),
                state.updated_at
              )
              AND reconciliation.reconciled_at > COALESCE(
                (
                  SELECT max(event.occurred_at)
                  FROM mutation_events AS event
                  JOIN intents AS intent ON intent.intent_id = event.intent_id
                  WHERE intent.authority_generation_hash = previous_generation.generation_hash
                ),
                state.updated_at
              )
              AND EXISTS (
                SELECT 1
                FROM position_snapshots AS snapshot
                WHERE snapshot.account_id = previous_generation.account_id
                  AND snapshot.position_count = 0
                  AND snapshot.observed_at <= reconciliation.reconciled_at
                  AND NOT EXISTS (
                    SELECT 1
                    FROM position_snapshots AS later
                    WHERE later.account_id = snapshot.account_id
                      AND (
                        later.observed_at > snapshot.observed_at
                        OR (
                          later.observed_at = snapshot.observed_at
                          AND later.snapshot_id COLLATE "C" > snapshot.snapshot_id COLLATE "C"
                        )
                      )
                  )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM (
                  SELECT DISTINCT ON (broker_order.broker_order_id)
                    broker_order.intent_id,
                    broker_order.status,
                    event.observed_at
                  FROM orders AS broker_order
                  JOIN broker_events AS event ON event.event_id = broker_order.event_id
                  WHERE broker_order.account_id = previous_generation.account_id
                  ORDER BY broker_order.broker_order_id, event.source_sequence DESC
                ) AS latest_order
                WHERE latest_order.intent_id IS NULL
                  OR latest_order.status IN ('NEW', 'PARTIALLY_FILLED', 'PENDING')
                  OR latest_order.observed_at > reconciliation.reconciled_at
              )
            )
          )
      )
    $function$
  `
})
