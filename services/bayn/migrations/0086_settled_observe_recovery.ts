import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE FUNCTION observe_recovery_account_settled(
      current_generation_hash text,
      reconciled_at timestamptz
    )
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      WITH RECURSIVE lineage AS (
        SELECT generation.*
        FROM authority_generations AS generation
        WHERE generation.generation_hash = current_generation_hash
        UNION ALL
        SELECT parent.*
        FROM authority_generations AS parent
        JOIN lineage AS child ON parent.generation_hash = child.previous_generation_hash
        WHERE child.maximum = 'OBSERVE'
          AND parent.account_id = child.account_id
          AND parent.broker_identity_hash = child.broker_identity_hash
          AND parent.broker_environment = child.broker_environment
          AND parent.authority_version < child.authority_version
      )
      SELECT EXISTS (
        SELECT 1 FROM authority_generations AS generation
        WHERE generation.generation_hash = current_generation_hash
          AND (
            NOT EXISTS (
              SELECT 1 FROM mutation_events AS mutation
              JOIN intents AS intent ON intent.intent_id = mutation.intent_id
              WHERE intent.account_id = generation.account_id
            )
            OR (
              generation.broker_environment = 'sandbox'
              AND EXISTS (
                SELECT 1 FROM lineage AS research
                WHERE research.maximum = 'PAPER'
                  AND research.activation_schema_version = 'bayn.paper-authority-generation.v3'
                  AND research.research_plan_hash IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM autonomous_cycles AS cycle
                JOIN lineage AS research ON research.research_plan_hash = cycle.qualification_run_id
                WHERE cycle.account_id = generation.account_id
                  AND cycle.state IN ('PENDING', 'ACTIVE')
                  AND cycle.decision_hash IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM intents AS intent
                WHERE intent.account_id = generation.account_id
                  AND (intent.state <> 'TERMINAL' OR intent.updated_at >= reconciled_at)
              )
              AND NOT paper_account_has_unresolved_mutation(generation.account_id, reconciled_at)
              AND NOT EXISTS (
                SELECT 1 FROM mutation_events AS mutation
                JOIN intents AS intent ON intent.intent_id = mutation.intent_id
                WHERE intent.account_id = generation.account_id
                  AND mutation.occurred_at >= reconciled_at
              )
              AND EXISTS (
                SELECT 1 FROM (
                  SELECT position_count, observed_at FROM position_snapshots
                  WHERE account_id = generation.account_id
                    AND ingestion_order_trusted
                  ORDER BY ingestion_sequence DESC LIMIT 1
                ) AS position
                WHERE position.position_count = 0 AND position.observed_at <= reconciled_at
                  AND position.observed_at >= (SELECT updated_at FROM authority_state WHERE singleton)
              )
              AND NOT EXISTS (
                SELECT 1 FROM (
                  SELECT DISTINCT ON (broker_order.broker_order_id)
                    broker_order.intent_id, broker_order.status, event.observed_at
                  FROM orders AS broker_order
                  JOIN broker_events AS event ON event.event_id = broker_order.event_id
                  WHERE broker_order.account_id = generation.account_id
                  ORDER BY broker_order.broker_order_id, event.source_sequence DESC
                ) AS latest_order
                WHERE latest_order.intent_id IS NULL
                  OR latest_order.status IN ('NEW', 'PARTIALLY_FILLED', 'PENDING')
                  OR latest_order.observed_at > reconciled_at
              )
            )
          )
      )
    $function$
  `

  yield* sql`
    DO $migration$
    DECLARE
      definition text := pg_get_functiondef('enforce_authority_transition()'::regprocedure);
      previous_guard constant text := $guard$AND NOT EXISTS (
                  SELECT 1
                  FROM mutation_events AS mutation
                  JOIN intents AS intent ON intent.intent_id = mutation.intent_id
                  WHERE intent.account_id = generation.account_id
                )$guard$;
      settled_guard constant text := $guard$AND observe_recovery_account_settled(
                  OLD.generation_hash, reconciliation.reconciled_at
                )$guard$;
    BEGIN
      IF (length(definition) - length(replace(definition, previous_guard, ''))) <> length(previous_guard) THEN
        RAISE EXCEPTION 'expected exactly one OBSERVE recovery account guard' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(definition, previous_guard, settled_guard);
    END
    $migration$
  `
})
