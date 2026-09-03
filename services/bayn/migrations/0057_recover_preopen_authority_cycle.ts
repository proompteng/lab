import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export const recoverPreopenAuthorityCycle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    DO $migration$
    DECLARE
      repair_observed_at timestamptz := clock_timestamp();
      repairable_cycle_ids text[];
      trigger_disabled boolean := false;
    BEGIN
      PERFORM pg_advisory_xact_lock(1111578958, 1);

      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'autonomous_cycles'::regclass
          AND tgname = 'autonomous_cycle_lifecycle'
          AND tgenabled = 'O'
      ) THEN
        RAISE EXCEPTION 'autonomous cycle lifecycle trigger is not enabled' USING ERRCODE = '55000';
      END IF;

      LOCK TABLE autonomous_cycles IN SHARE ROW EXCLUSIVE MODE;

      SELECT coalesce(array_agg(cycle.cycle_id ORDER BY cycle.cycle_id COLLATE "C"), ARRAY[]::text[])
      INTO repairable_cycle_ids
      FROM autonomous_cycles AS cycle
      JOIN authority_state AS state ON state.singleton
      JOIN authority_generations AS generation
        ON generation.generation_hash = state.generation_hash
      JOIN LATERAL (
        SELECT candidate.*
        FROM reconciliations AS candidate
        WHERE candidate.account_id = cycle.account_id
        ORDER BY candidate.reconciled_at DESC, candidate.reconciliation_id COLLATE "C" DESC
        LIMIT 1
      ) AS reconciliation ON true
      JOIN LATERAL (
        SELECT candidate.*
        FROM position_snapshots AS candidate
        WHERE candidate.account_id = cycle.account_id
          AND candidate.ingestion_order_trusted
          AND candidate.observed_at <= repair_observed_at
        ORDER BY candidate.ingestion_sequence DESC
        LIMIT 1
      ) AS positions ON true
      WHERE cycle.schema_version = 'bayn.autonomous-cycle.v3'
        AND cycle.identity_schema_version = 'bayn.autonomous-cycle-identity.v3'
        AND cycle.state = 'BLOCKED'
        AND cycle.terminal_reason = 'BLOCKED_AUTHORITY'
        AND cycle.snapshot_id IS NULL
        AND cycle.decision_hash IS NULL
        AND cycle.terminal_at = cycle.updated_at
        AND cycle.terminal_at < cycle.submission_open_at
        AND cycle.terminal_at <= repair_observed_at
        AND repair_observed_at < cycle.submission_open_at
        AND state.maximum = 'PAPER'
        AND state.effective = 'PAPER'
        AND state.kill_state = 'CLEAR'
        AND state.reason IS NULL
        AND generation.maximum = 'PAPER'
        AND generation.activation_schema_version = 'bayn.paper-authority-generation.v3'
        AND generation.account_id = cycle.account_id
        AND generation.research_plan_hash = cycle.qualification_run_id
        AND generation.strategy_name = cycle.strategy_name
        AND generation.strategy_protocol_hash = cycle.strategy_protocol_hash
        AND reconciliation.status = 'EXACT'
        AND reconciliation.expected_hash = reconciliation.observed_hash
        AND jsonb_array_length(reconciliation.discrepancies) = 0
        AND reconciliation.reconciled_at >= state.updated_at
        AND positions.position_count = 0
        AND positions.observed_at <= reconciliation.reconciled_at
        AND NOT paper_account_has_unresolved_mutation(cycle.account_id, reconciliation.reconciled_at)
        AND NOT EXISTS (
          SELECT 1
          FROM autonomous_cycle_shadow_decisions AS decision
          WHERE decision.cycle_id = cycle.cycle_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM intents AS intent
          WHERE intent.cycle_id = cycle.cycle_id
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
            WHERE broker_order.account_id = cycle.account_id
            ORDER BY broker_order.broker_order_id, event.source_sequence DESC
          ) AS latest_order
          WHERE latest_order.intent_id IS NULL
            OR latest_order.status IN ('NEW', 'PARTIALLY_FILLED', 'PENDING')
            OR latest_order.observed_at > reconciliation.reconciled_at
        );

      IF cardinality(repairable_cycle_ids) > 1 THEN
        RAISE EXCEPTION 'refusing to recover more than one preopen authority cycle' USING ERRCODE = '55000';
      END IF;

      IF cardinality(repairable_cycle_ids) = 1 THEN
        EXECUTE 'ALTER TABLE autonomous_cycles DISABLE TRIGGER autonomous_cycle_lifecycle';
        trigger_disabled := true;

        UPDATE autonomous_cycles AS cycle
        SET
          state = 'ACTIVE',
          terminal_reason = NULL,
          state_version = cycle.state_version + 1,
          updated_at = greatest(repair_observed_at, cycle.updated_at + interval '1 microsecond'),
          terminal_at = NULL
        WHERE cycle.cycle_id = repairable_cycle_ids[1];

        EXECUTE 'ALTER TABLE autonomous_cycles ENABLE TRIGGER autonomous_cycle_lifecycle';
        trigger_disabled := false;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        IF trigger_disabled THEN
          EXECUTE 'ALTER TABLE autonomous_cycles ENABLE TRIGGER autonomous_cycle_lifecycle';
        END IF;
        RAISE;
    END
    $migration$
  `
})

export default recoverPreopenAuthorityCycle
