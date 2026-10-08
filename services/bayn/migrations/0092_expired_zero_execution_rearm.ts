import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // A zero-execution mandate cannot produce qualified performance. Prove settlement instead;
  // do not fabricate a profitability receipt or exempt a mandate that actually traded.
  yield* sql`
    CREATE FUNCTION research_paper_expired_zero_execution_settled(current_generation_hash text)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      SELECT EXISTS (
        SELECT 1
        FROM authority_state AS state
        JOIN authority_generations AS generation ON generation.generation_hash = state.generation_hash
        JOIN LATERAL (
          SELECT * FROM reconciliations
          WHERE account_id = generation.account_id
          ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC LIMIT 1
        ) AS reconciliation ON true
        WHERE state.singleton
          AND generation.generation_hash = current_generation_hash
          AND generation.maximum = 'PAPER'
          AND generation.broker_environment = 'sandbox'
          AND state.maximum = 'PAPER'
          AND state.effective = 'OBSERVE'
          AND state.kill_state = 'ACTIVE'
          AND state.reason IN (
            'execution activation lease restricted effective authority: immutable activation request expired',
            'PAPER activation lease restricted effective authority: immutable activation request expired'
          )
          AND reconciliation.status = 'EXACT'
          AND reconciliation.expected_hash = reconciliation.observed_hash
          AND jsonb_array_length(reconciliation.discrepancies) = 0
          AND reconciliation.reconciled_at > state.updated_at
          AND NOT EXISTS (
            SELECT 1 FROM intents AS intent
            WHERE intent.authority_generation_hash = generation.generation_hash
              AND (
                EXISTS (SELECT 1 FROM fills AS fill WHERE fill.intent_id = intent.intent_id)
                OR EXISTS (SELECT 1 FROM accounting_transactions AS transaction WHERE transaction.intent_id = intent.intent_id)
                OR EXISTS (
                  SELECT 1 FROM orders AS broker_order
                  WHERE broker_order.intent_id = intent.intent_id AND broker_order.filled_quantity_micros > 0
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM intents AS intent
            WHERE intent.account_id = generation.account_id
              AND (intent.state <> 'TERMINAL' OR intent.updated_at >= reconciliation.reconciled_at)
          )
          AND NOT paper_account_has_unresolved_mutation(generation.account_id, reconciliation.reconciled_at)
          AND NOT EXISTS (
            SELECT 1 FROM mutation_events AS mutation
            JOIN intents AS intent ON intent.intent_id = mutation.intent_id
            WHERE intent.account_id = generation.account_id
              AND mutation.occurred_at >= reconciliation.reconciled_at
          )
          AND EXISTS (
            SELECT 1 FROM (
              SELECT position_count, observed_at FROM position_snapshots
              WHERE account_id = generation.account_id AND ingestion_order_trusted
              ORDER BY ingestion_sequence DESC LIMIT 1
            ) AS position
            WHERE position.position_count = 0
              AND position.observed_at >= state.updated_at
              AND position.observed_at <= reconciliation.reconciled_at
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
              OR latest_order.observed_at > reconciliation.reconciled_at
          )
      )
    $function$
  `

  // Change only the receipt prerequisite; existing candidate identity, cycle terminality,
  // reconciliation, position, order and mutation checks remain enforced by the rearm function.
  yield* sql`
    DO $migration$
    DECLARE
      definition text := pg_get_functiondef('research_paper_rearm_eligible(text,bigint,timestamptz)'::regprocedure);
      old_guard constant text := $guard$AND EXISTS (
                    SELECT 1
                    FROM autonomous_forward_performance_receipts AS receipt
                    WHERE receipt.authority_generation_hash = previous_generation.generation_hash
                  )$guard$;
      new_guard constant text := $guard$AND (
                    EXISTS (
                      SELECT 1
                      FROM autonomous_forward_performance_receipts AS receipt
                      WHERE receipt.authority_generation_hash = previous_generation.generation_hash
                    )
                    OR research_paper_expired_zero_execution_settled(previous_generation.generation_hash)
                  )$guard$;
    BEGIN
      IF (length(definition) - length(replace(definition, old_guard, ''))) <> length(old_guard) THEN
        RAISE EXCEPTION 'expected exactly one terminal performance receipt rearm guard' USING ERRCODE = '55000';
      END IF;
      EXECUTE replace(definition, old_guard, new_guard);
    END
    $migration$
  `
})
