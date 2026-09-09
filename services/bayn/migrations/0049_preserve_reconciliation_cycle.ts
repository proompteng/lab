import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

// The pre-v49 runtime discarded the transient restriction reason when it rotated back through OBSERVE. Do not infer
// that lost reason from a generic terminal shape: this reviewed migration may repair only the one observed incident.
export const reconciliationRearmIncidentCycleId = '3d53e1c6f02adc1b930e3549e48cd4158ecb3be384a32ef2ecd228aeece16c49'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Migration 37 owns the complete authority proof and migration 48 added the transient reconciliation reason.
  // Exclude only the untouched v3 cycle that the same-plan recovery explicitly preserves before submission opens.
  yield* sql`
    DO $migration$
    DECLARE
      function_definition text := pg_get_functiondef(
        'research_paper_rearm_eligible(text,bigint,timestamptz)'::regprocedure
      );
      anchor constant text := 'AND cycle.state IN (''PENDING'', ''ACTIVE'')';
      preserved_cycle_guard constant text := $guard$AND cycle.state IN ('PENDING', 'ACTIVE')
              AND NOT (
                state.reason = 'reconciliation pass incomplete'
                AND previous_generation.activation_schema_version = 'bayn.paper-authority-generation.v3'
                AND cycle.schema_version = 'bayn.autonomous-cycle.v3'
                AND cycle.snapshot_id IS NULL
                AND cycle.decision_hash IS NULL
                AND cycle.updated_at <= candidate_activated_at
                AND candidate_activated_at < cycle.submission_open_at
                AND NOT EXISTS (
                  SELECT 1
                  FROM intents AS cycle_intent
                  WHERE cycle_intent.cycle_id = cycle.cycle_id
                )
              )$guard$;
    BEGIN
      IF strpos(function_definition, preserved_cycle_guard) > 0 THEN
        RAISE EXCEPTION 'research reconciliation cycle preservation already exists' USING ERRCODE = '55000';
      END IF;

      IF (
        length(function_definition) - length(replace(function_definition, anchor, ''))
      ) <> length(anchor) THEN
        RAISE EXCEPTION 'expected exactly one research rearm cycle guard' USING ERRCODE = '55000';
      END IF;

      function_definition := replace(function_definition, anchor, preserved_cycle_guard);
      EXECUTE function_definition;
    END
    $migration$
  `

  // Repair only the reviewed incident declared above, after proving its immutable same-plan generation chain and
  // untouched-cycle shape. The cycle ID is the durable identity binding for strategy, account, plan, and session; a
  // similar clear-PAPER or failed-mandate rollover cannot be inferred into this repair. The lifecycle trigger stays
  // authoritative outside this one migration transaction.
  yield* sql`
    DO $migration$
    DECLARE
      incident_cycle_id constant text := '3d53e1c6f02adc1b930e3549e48cd4158ecb3be384a32ef2ecd228aeece16c49';
      repaired_count integer;
    BEGIN
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
      EXECUTE 'ALTER TABLE autonomous_cycles DISABLE TRIGGER autonomous_cycle_lifecycle';

      WITH repairable AS (
        SELECT cycle.cycle_id
        FROM autonomous_cycles AS cycle
        JOIN authority_state AS state ON state.singleton
        JOIN authority_generations AS current_generation
          ON current_generation.generation_hash = state.generation_hash
        JOIN authority_generations AS observe_generation
          ON observe_generation.generation_hash = current_generation.previous_generation_hash
        JOIN authority_generations AS previous_generation
          ON previous_generation.generation_hash = observe_generation.previous_generation_hash
        JOIN LATERAL (
          SELECT reconciliation.*
          FROM reconciliations AS reconciliation
          WHERE reconciliation.account_id = cycle.account_id
          ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
          LIMIT 1
        ) AS reconciliation ON true
        WHERE cycle.cycle_id = incident_cycle_id
          AND cycle.schema_version = 'bayn.autonomous-cycle.v3'
          AND cycle.identity_schema_version = 'bayn.autonomous-cycle-identity.v3'
          AND cycle.strategy_name = 'opening-drive-momentum'
          AND cycle.state = 'BLOCKED'
          AND cycle.terminal_reason = 'BLOCKED_PROVENANCE_MISMATCH'
          AND cycle.snapshot_id IS NULL
          AND cycle.decision_hash IS NULL
          AND cycle.terminal_at = cycle.updated_at
          AND clock_timestamp() < cycle.submission_open_at
          AND state.maximum = 'PAPER'
          AND state.effective = 'PAPER'
          AND state.kill_state = 'CLEAR'
          AND state.reason IS NULL
          AND current_generation.maximum = 'PAPER'
          AND current_generation.activation_schema_version = 'bayn.paper-authority-generation.v3'
          AND current_generation.proof_plan_hash = cycle.qualification_run_id
          AND current_generation.account_id = cycle.account_id
          AND current_generation.activated_at >= observe_generation.activated_at
          AND observe_generation.maximum = 'OBSERVE'
          AND observe_generation.activation_schema_version IS NULL
          AND observe_generation.activated_at = cycle.terminal_at
          AND previous_generation.maximum = 'PAPER'
          AND previous_generation.activation_schema_version = 'bayn.paper-authority-generation.v3'
          AND previous_generation.proof_plan_hash = current_generation.proof_plan_hash
          AND previous_generation.account_id = current_generation.account_id
          AND reconciliation.status = 'EXACT'
          AND reconciliation.expected_hash = reconciliation.observed_hash
          AND jsonb_array_length(reconciliation.discrepancies) = 0
          AND reconciliation.reconciled_at > state.updated_at
          AND NOT paper_account_has_unresolved_mutation(cycle.account_id, reconciliation.reconciled_at)
          AND EXISTS (
            SELECT 1
            FROM position_snapshots AS position_snapshot
            WHERE position_snapshot.account_id = cycle.account_id
              AND position_snapshot.position_count = 0
              AND position_snapshot.observed_at <= reconciliation.reconciled_at
              AND NOT EXISTS (
                SELECT 1
                FROM position_snapshots AS later_snapshot
                WHERE later_snapshot.account_id = position_snapshot.account_id
                  AND (
                    later_snapshot.observed_at > position_snapshot.observed_at
                    OR (
                      later_snapshot.observed_at = position_snapshot.observed_at
                      AND later_snapshot.snapshot_id COLLATE "C" > position_snapshot.snapshot_id COLLATE "C"
                    )
                  )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM intents AS cycle_intent
            WHERE cycle_intent.cycle_id = cycle.cycle_id
          )
        FOR UPDATE OF cycle
      )
      UPDATE autonomous_cycles AS cycle
      SET
        state = 'ACTIVE',
        terminal_reason = NULL,
        state_version = cycle.state_version + 1,
        updated_at = greatest(clock_timestamp(), cycle.updated_at + interval '1 microsecond'),
        terminal_at = NULL
      FROM repairable
      WHERE cycle.cycle_id = repairable.cycle_id;

      GET DIAGNOSTICS repaired_count = ROW_COUNT;
      IF repaired_count > 1 THEN
        RAISE EXCEPTION 'refusing to repair more than one reconciliation-terminalized cycle'
          USING ERRCODE = '55000';
      END IF;

      EXECUTE 'ALTER TABLE autonomous_cycles ENABLE TRIGGER autonomous_cycle_lifecycle';
    EXCEPTION
      WHEN OTHERS THEN
        EXECUTE 'ALTER TABLE autonomous_cycles ENABLE TRIGGER autonomous_cycle_lifecycle';
        RAISE;
    END
    $migration$
  `
})
