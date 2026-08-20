import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE authority_generations
      DROP CONSTRAINT authority_generations_strategy_name_check,
      DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
      DROP CONSTRAINT IF EXISTS authority_generations_strategy_contract_check,
      ADD CONSTRAINT authority_generations_strategy_name_check CHECK (
        strategy_name IN ('risk-balanced-trend', 'opening-drive-momentum')
      ),
      ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
        strategy_parameter_schema_version IN (
          'bayn.risk-balanced-trend.protocol.v3',
          'bayn.risk-balanced-trend.protocol.v4',
          'bayn.opening-drive.protocol.v2'
        )
      ),
      ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
        (strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
        OR (
          strategy_name = 'risk-balanced-trend'
          AND strategy_parameter_schema_version IN (
            'bayn.risk-balanced-trend.protocol.v3',
            'bayn.risk-balanced-trend.protocol.v4'
          )
        )
        OR (
          strategy_name = 'opening-drive-momentum'
          AND strategy_parameter_schema_version = 'bayn.opening-drive.protocol.v2'
        )
      )
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      ALTER COLUMN signal_session_date DROP NOT NULL,
      ALTER COLUMN signal_calendar_version DROP NOT NULL,
      ALTER COLUMN signal_close_at DROP NOT NULL,
      ALTER COLUMN publication_deadline_at DROP NOT NULL,
      ALTER COLUMN submission_cutoff_before_open_ms DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS submission_cutoff_after_open_ms integer,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_snapshot_id_fkey,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_identity_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_strategy_name_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_execution_policy_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_window_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_contract_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_publication_deadline_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_execution_window_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_submission_cutoff_offset_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_contract_material_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycles_state_bindings_check
  `

  yield* sql`
    DO $migration$
    DECLARE
      old_constraint text;
      constraint_definition text;
    BEGIN
      FOR old_constraint, constraint_definition IN
        SELECT conname, pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE conrelid = 'autonomous_cycles'::regclass
          AND contype = 'c'
      LOOP
        IF (
          constraint_definition LIKE '%state = ''ACTIVE''%'
          AND constraint_definition LIKE '%snapshot_id IS NOT NULL%'
          AND constraint_definition LIKE '%terminal_at%'
        ) THEN
          EXECUTE format('ALTER TABLE autonomous_cycles DROP CONSTRAINT %I', old_constraint);
        END IF;
      END LOOP;
    END
    $migration$
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      ADD CONSTRAINT autonomous_cycles_schema_version_check
        CHECK (
          schema_version IN (
            'bayn.autonomous-cycle.v1',
            'bayn.autonomous-cycle.v2',
            'bayn.autonomous-cycle.v3'
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_identity_schema_version_check
        CHECK (
          identity_schema_version IN (
            'bayn.autonomous-cycle-identity.v1',
            'bayn.autonomous-cycle-identity.v2',
            'bayn.autonomous-cycle-identity.v3'
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_strategy_name_check
        CHECK (strategy_name IN ('risk-balanced-trend', 'opening-drive-momentum')) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_execution_policy_schema_version_check
        CHECK (
          execution_policy_schema_version IN (
            'bayn.autonomous-cycle-execution-policy.v1',
            'bayn.autonomous-cycle-execution-policy.v2'
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_window_schema_version_check
        CHECK (
          window_schema_version IN (
            'bayn.autonomous-cycle-window.v1',
            'bayn.autonomous-cycle-window.v2',
            'bayn.autonomous-cycle-window.v3'
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_contract_version_check
        CHECK (
          (
            schema_version = 'bayn.autonomous-cycle.v1'
            AND identity_schema_version = 'bayn.autonomous-cycle-identity.v1'
            AND strategy_name = 'risk-balanced-trend'
            AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v1'
            AND window_schema_version = 'bayn.autonomous-cycle-window.v1'
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v2'
            AND identity_schema_version = 'bayn.autonomous-cycle-identity.v2'
            AND strategy_name = 'opening-drive-momentum'
            AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2'
            AND window_schema_version = 'bayn.autonomous-cycle-window.v2'
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v3'
            AND identity_schema_version = 'bayn.autonomous-cycle-identity.v3'
            AND strategy_name = 'opening-drive-momentum'
            AND execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v2'
            AND window_schema_version = 'bayn.autonomous-cycle-window.v3'
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_contract_material_check
        CHECK (
          (
            schema_version IN ('bayn.autonomous-cycle.v1', 'bayn.autonomous-cycle.v2')
            AND signal_session_date IS NOT NULL
            AND signal_calendar_version IS NOT NULL
            AND signal_close_at IS NOT NULL
            AND publication_deadline_at IS NOT NULL
            AND submission_cutoff_before_open_ms BETWEEN 1 AND 86400000
            AND submission_cutoff_after_open_ms IS NULL
            AND signal_session_date < execution_session_date
            AND signal_close_at < submission_open_at
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v3'
            AND signal_session_date IS NULL
            AND signal_calendar_version IS NULL
            AND signal_close_at IS NULL
            AND publication_deadline_at IS NULL
            AND submission_cutoff_before_open_ms IS NULL
            AND submission_cutoff_after_open_ms BETWEEN 1 AND 86400000
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_publication_deadline_check
        CHECK (
          (
            schema_version = 'bayn.autonomous-cycle.v1'
            AND publication_deadline_at = submission_open_at
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v2'
            AND publication_deadline_at = execution_open_at
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v3'
            AND publication_deadline_at IS NULL
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_execution_window_check
        CHECK (
          submission_open_at < submission_cutoff_at
          AND execution_open_at < execution_close_at
          AND (
            (
              schema_version = 'bayn.autonomous-cycle.v1'
              AND submission_cutoff_at < execution_open_at
            )
            OR (
              schema_version IN ('bayn.autonomous-cycle.v2', 'bayn.autonomous-cycle.v3')
              AND execution_open_at < submission_open_at
              AND submission_cutoff_at < execution_close_at
            )
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_submission_cutoff_offset_check
        CHECK (
          (
            schema_version = 'bayn.autonomous-cycle.v1'
            AND execution_open_at =
              submission_cutoff_at + submission_cutoff_before_open_ms * interval '1 millisecond'
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v2'
            AND submission_cutoff_at =
              execution_open_at + submission_cutoff_before_open_ms * interval '1 millisecond'
          )
          OR (
            schema_version = 'bayn.autonomous-cycle.v3'
            AND submission_cutoff_at =
              execution_open_at + submission_cutoff_after_open_ms * interval '1 millisecond'
          )
        ) NOT VALID,
      ADD CONSTRAINT autonomous_cycles_state_bindings_check
        CHECK (
          (
            state = 'PENDING'
            AND decision_hash IS NULL
            AND terminal_reason IS NULL
            AND terminal_at IS NULL
          )
          OR (
            state = 'ACTIVE'
            AND (schema_version = 'bayn.autonomous-cycle.v3' OR snapshot_id IS NOT NULL)
            AND terminal_reason IS NULL
            AND terminal_at IS NULL
          )
          OR (
            state IN ('COMPLETED', 'NO_TRADE')
            AND snapshot_id IS NOT NULL
            AND decision_hash IS NOT NULL
            AND terminal_reason IS NULL
            AND terminal_at = updated_at
          )
          OR (
            state = 'BLOCKED'
            AND terminal_reason IS NOT NULL
            AND terminal_at = updated_at
          )
        ) NOT VALID
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
      VALIDATE CONSTRAINT autonomous_cycles_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_identity_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_strategy_name_check,
      VALIDATE CONSTRAINT autonomous_cycles_execution_policy_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_window_schema_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_contract_version_check,
      VALIDATE CONSTRAINT autonomous_cycles_contract_material_check,
      VALIDATE CONSTRAINT autonomous_cycles_publication_deadline_check,
      VALIDATE CONSTRAINT autonomous_cycles_execution_window_check,
      VALIDATE CONSTRAINT autonomous_cycles_submission_cutoff_offset_check,
      VALIDATE CONSTRAINT autonomous_cycles_state_bindings_check
  `

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS autonomous_cycles_intraday_authority_slot_key
    ON autonomous_cycles(qualification_run_id, account_id, execution_session_date)
    WHERE schema_version IN ('bayn.autonomous-cycle.v2', 'bayn.autonomous-cycle.v3')
  `

  yield* sql`
    DROP INDEX IF EXISTS autonomous_cycles_unfinished_idx
  `

  yield* sql`
    CREATE INDEX autonomous_cycles_unfinished_idx
    ON autonomous_cycles(execution_session_date, cycle_id)
    WHERE state IN ('PENDING', 'ACTIVE')
  `

  // Migration 21 owns the lifecycle policy and migration 39 tightened its authority guard. Patch only the four
  // version-sensitive clauses so upgraded databases retain every terminalization invariant byte-for-byte.
  yield* sql`
    DO $migration$
    DECLARE
      lifecycle_definition text := pg_get_functiondef('enforce_autonomous_cycle_lifecycle()'::regprocedure);
      old_fragment text;
      new_fragment text;
    BEGIN
      IF strpos(lifecycle_definition, 'bayn.autonomous-cycle.v3') > 0 THEN
        IF (
          strpos(lifecycle_definition, 'NEW.schema_version <> ''bayn.autonomous-cycle.v3''') > 0
          AND strpos(lifecycle_definition, 'OLD.schema_version = ''bayn.autonomous-cycle.v3''') > 0
          AND strpos(
            lifecycle_definition,
            'AND NEW.schema_version <> ''bayn.autonomous-cycle.v3'' THEN'
          ) > 0
          AND strpos(lifecycle_definition, 'NEW.schema_version = ''bayn.autonomous-cycle.v3''') > 0
        ) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'partial or divergent intraday autonomous-cycle lifecycle support exists'
          USING ERRCODE = '55000';
      END IF;

      old_fragment := $old$OR (
            NEW.state = 'BLOCKED'
            AND NEW.snapshot_id IS NULL
            AND NEW.decision_hash IS NULL
            AND NEW.terminal_reason = 'BLOCKED_MISSED_PUBLICATION_DEADLINE'$old$;
      new_fragment := $new$OR (
            NEW.schema_version <> 'bayn.autonomous-cycle.v3'
            AND NEW.state = 'BLOCKED'
            AND NEW.snapshot_id IS NULL
            AND NEW.decision_hash IS NULL
            AND NEW.terminal_reason = 'BLOCKED_MISSED_PUBLICATION_DEADLINE'$new$;
      IF (
        length(lifecycle_definition) - length(replace(lifecycle_definition, old_fragment, ''))
      ) <> length(old_fragment) THEN
        RAISE EXCEPTION 'expected exactly one initial lifecycle fragment' USING ERRCODE = '55000';
      END IF;
      lifecycle_definition := replace(lifecycle_definition, old_fragment, new_fragment);

      old_fragment := $old$IF OLD.state = NEW.state AND NOT (
        (
          OLD.state = 'PENDING'
          AND OLD.snapshot_id IS NULL
          AND NEW.snapshot_id IS NOT NULL
          AND NEW.decision_hash IS NOT DISTINCT FROM OLD.decision_hash
        )
        OR (
          OLD.state = 'ACTIVE'
          AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id
          AND OLD.decision_hash IS NULL
          AND NEW.decision_hash IS NOT NULL
        )
      )$old$;
      new_fragment := $new$IF OLD.state = NEW.state AND NOT (
        (
          OLD.schema_version <> 'bayn.autonomous-cycle.v3'
          AND OLD.state = 'PENDING'
          AND OLD.snapshot_id IS NULL
          AND NEW.snapshot_id IS NOT NULL
          AND NEW.decision_hash IS NOT DISTINCT FROM OLD.decision_hash
        )
        OR (
          OLD.schema_version <> 'bayn.autonomous-cycle.v3'
          AND OLD.state = 'ACTIVE'
          AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id
          AND OLD.decision_hash IS NULL
          AND NEW.decision_hash IS NOT NULL
        )
        OR (
          OLD.schema_version = 'bayn.autonomous-cycle.v3'
          AND OLD.state = 'ACTIVE'
          AND OLD.snapshot_id IS NULL
          AND NEW.snapshot_id IS NOT NULL
          AND OLD.decision_hash IS NULL
          AND NEW.decision_hash IS NOT NULL
        )
      )$new$;
      IF (
        length(lifecycle_definition) - length(replace(lifecycle_definition, old_fragment, ''))
      ) <> length(old_fragment) THEN
        RAISE EXCEPTION 'expected exactly one binding lifecycle fragment' USING ERRCODE = '55000';
      END IF;
      lifecycle_definition := replace(lifecycle_definition, old_fragment, new_fragment);

      old_fragment := 'IF OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL THEN';
      new_fragment :=
        'IF OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL '
        || 'AND NEW.schema_version <> ''bayn.autonomous-cycle.v3'' THEN';
      IF (
        length(lifecycle_definition) - length(replace(lifecycle_definition, old_fragment, ''))
      ) <> length(old_fragment) THEN
        RAISE EXCEPTION 'expected exactly one snapshot lifecycle fragment' USING ERRCODE = '55000';
      END IF;
      lifecycle_definition := replace(lifecycle_definition, old_fragment, new_fragment);

      old_fragment := $old$AND (
          OLD.state <> 'PENDING'
          OR OLD.snapshot_id IS NOT NULL
          OR NEW.updated_at < NEW.publication_deadline_at
        )$old$;
      new_fragment := $new$AND (
          NEW.schema_version = 'bayn.autonomous-cycle.v3'
          OR OLD.state <> 'PENDING'
          OR OLD.snapshot_id IS NOT NULL
          OR NEW.updated_at < NEW.publication_deadline_at
        )$new$;
      IF (
        length(lifecycle_definition) - length(replace(lifecycle_definition, old_fragment, ''))
      ) <> length(old_fragment) THEN
        RAISE EXCEPTION 'expected exactly one missed-publication lifecycle fragment' USING ERRCODE = '55000';
      END IF;
      lifecycle_definition := replace(lifecycle_definition, old_fragment, new_fragment);

      EXECUTE lifecycle_definition;
    END
    $migration$
  `
})
