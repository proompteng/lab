import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_autonomous_cycle_lifecycle()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      mutable_columns text[] := ARRAY[
        'state',
        'snapshot_id',
        'decision_hash',
        'terminal_reason',
        'state_version',
        'updated_at',
        'terminal_at'
      ];
      expected_target_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'autonomous cycles cannot be deleted' USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.state_version <> 1 OR NEW.created_at <> NEW.updated_at OR NOT (
          (NEW.state = 'PENDING' AND NEW.snapshot_id IS NULL AND NEW.decision_hash IS NULL)
          OR (
            NEW.state = 'BLOCKED'
            AND NEW.snapshot_id IS NULL
            AND NEW.decision_hash IS NULL
            AND NEW.terminal_reason = 'BLOCKED_MISSED_PUBLICATION_DEADLINE'
            AND NEW.updated_at >= NEW.publication_deadline_at
          )
        ) THEN
          RAISE EXCEPTION 'invalid initial autonomous cycle state' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.state IN ('COMPLETED', 'NO_TRADE', 'BLOCKED') THEN
        RAISE EXCEPTION 'terminal autonomous cycle history cannot change' USING ERRCODE = '55000';
      END IF;

      IF (OLD.state, NEW.state) NOT IN (
        ('PENDING', 'PENDING'),
        ('PENDING', 'ACTIVE'),
        ('PENDING', 'BLOCKED'),
        ('ACTIVE', 'ACTIVE'),
        ('ACTIVE', 'COMPLETED'),
        ('ACTIVE', 'NO_TRADE'),
        ('ACTIVE', 'BLOCKED')
      ) THEN
        RAISE EXCEPTION 'invalid autonomous cycle state transition' USING ERRCODE = '23514';
      END IF;
      IF OLD.state = NEW.state AND NOT (
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
      ) THEN
        RAISE EXCEPTION 'invalid autonomous cycle binding transition' USING ERRCODE = '23514';
      END IF;
      IF OLD.state <> NEW.state AND (
        NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
        OR NEW.decision_hash IS DISTINCT FROM OLD.decision_hash
      ) THEN
        RAISE EXCEPTION 'autonomous cycle state transitions cannot change bindings' USING ERRCODE = '23514';
      END IF;
      IF to_jsonb(OLD) - mutable_columns <> to_jsonb(NEW) - mutable_columns THEN
        RAISE EXCEPTION 'autonomous cycle identity and deadlines cannot change' USING ERRCODE = '55000';
      END IF;
      IF NEW.state_version <> OLD.state_version + 1 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'autonomous cycle version and time must advance monotonically' USING ERRCODE = '23514';
      END IF;
      IF OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL THEN
        IF NEW.updated_at < NEW.signal_close_at THEN
          RAISE EXCEPTION 'autonomous cycle snapshot cannot bind before signal close' USING ERRCODE = '23514';
        END IF;
        IF NEW.updated_at >= NEW.publication_deadline_at THEN
          RAISE EXCEPTION 'autonomous cycle snapshot missed publication deadline' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM snapshot_references
          WHERE snapshot_id = NEW.snapshot_id
            AND last_session = NEW.signal_session_date
            AND manifest->>'calendarVersion' = NEW.signal_calendar_version
        ) THEN
          RAISE EXCEPTION 'autonomous cycle snapshot does not match signal session and calendar'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      IF NEW.state = 'ACTIVE' AND NEW.updated_at >= NEW.submission_cutoff_at THEN
        RAISE EXCEPTION 'autonomous cycle activation or decision missed submission cutoff' USING ERRCODE = '23514';
      END IF;
      IF NEW.state IN ('COMPLETED', 'NO_TRADE') THEN
        expected_target_status := CASE NEW.state
          WHEN 'COMPLETED' THEN 'PLANNED'
          ELSE 'NO_TRADE'
        END;
        IF NOT EXISTS (
          SELECT 1
          FROM autonomous_cycle_shadow_decisions
          WHERE cycle_id = NEW.cycle_id
            AND decision_hash = NEW.decision_hash
            AND document #>> '{targetPlan,status}' = expected_target_status
        ) THEN
          RAISE EXCEPTION 'autonomous cycle terminal state does not match its shadow decision'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      IF NEW.state = 'BLOCKED' AND OLD.state = 'ACTIVE' AND OLD.decision_hash IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1
          FROM autonomous_cycle_shadow_decisions
          WHERE cycle_id = NEW.cycle_id
            AND decision_hash = NEW.decision_hash
            AND document #>> '{targetPlan,status}' = 'BLOCKED'
            AND NEW.terminal_reason = CASE document #>> '{targetPlan,reason}'
              WHEN 'SUBMISSION_CUTOFF_REACHED' THEN 'BLOCKED_MISSED_SUBMISSION_DEADLINE'
              WHEN 'IDENTITY_MISMATCH' THEN 'BLOCKED_PROVENANCE_MISMATCH'
              WHEN 'INPUT_MISMATCH' THEN 'BLOCKED_DATA_INVALID'
              WHEN 'INPUT_STALE' THEN 'BLOCKED_DATA_STALE'
              WHEN 'RECONCILIATION_NOT_EXACT' THEN 'BLOCKED_RECONCILIATION'
              WHEN 'ACCOUNT_NOT_ACTIVE' THEN 'BLOCKED_BROKER_DISABLED'
              WHEN 'UNKNOWN_ORDER' THEN 'BLOCKED_UNRESOLVED_MUTATION'
              WHEN 'UNRESOLVED_ORDER' THEN 'BLOCKED_UNRESOLVED_MUTATION'
              WHEN 'BELOW_MINIMUM_BUY_NOTIONAL' THEN 'BLOCKED_RISK'
              WHEN 'INSUFFICIENT_BUYING_POWER' THEN 'BLOCKED_RISK'
              WHEN 'NON_POSITIVE_EQUITY' THEN 'BLOCKED_RISK'
              WHEN 'SHORT_POSITION_NOT_ALLOWED' THEN 'BLOCKED_RISK'
              ELSE NULL
            END
        ) THEN
          RAISE EXCEPTION 'autonomous cycle blocked reason does not match its shadow decision'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      IF (
        NEW.state = 'BLOCKED'
        AND NEW.terminal_reason = 'BLOCKED_MISSED_PUBLICATION_DEADLINE'
        AND (
          OLD.state <> 'PENDING'
          OR OLD.snapshot_id IS NOT NULL
          OR NEW.updated_at < NEW.publication_deadline_at
        )
      ) THEN
        RAISE EXCEPTION 'invalid missed-publication transition' USING ERRCODE = '23514';
      END IF;
      IF (
        NEW.state = 'BLOCKED'
        AND NEW.terminal_reason = 'BLOCKED_MISSED_SUBMISSION_DEADLINE'
        AND NEW.updated_at < NEW.submission_cutoff_at
      ) THEN
        RAISE EXCEPTION 'invalid missed-submission transition' USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `
})
