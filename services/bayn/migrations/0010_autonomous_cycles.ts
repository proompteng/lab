import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE autonomous_cycles (
      cycle_id text PRIMARY KEY CHECK (cycle_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.autonomous-cycle.v1'),
      identity_schema_version text NOT NULL CHECK (
        identity_schema_version = 'bayn.autonomous-cycle-identity.v1'
      ),
      strategy_name text NOT NULL CHECK (strategy_name = 'risk-balanced-trend'),
      qualification_run_id text NOT NULL CHECK (qualification_run_id ~ '^[0-9a-f]{64}$'),
      strategy_protocol_hash text NOT NULL CHECK (strategy_protocol_hash ~ '^[0-9a-f]{64}$'),
      account_id text NOT NULL CHECK (length(account_id) > 0 AND account_id = btrim(account_id)),
      signal_session_date date NOT NULL,
      calendar_version text NOT NULL CHECK (
        length(calendar_version) > 0 AND calendar_version = btrim(calendar_version)
      ),
      execution_policy_schema_version text NOT NULL CHECK (
        execution_policy_schema_version = 'bayn.autonomous-cycle-execution-policy.v1'
      ),
      execution_policy_hash text NOT NULL CHECK (execution_policy_hash ~ '^[0-9a-f]{64}$'),
      strategy_execution_model_hash text NOT NULL CHECK (
        strategy_execution_model_hash ~ '^[0-9a-f]{64}$'
      ),
      submission_window_ms integer NOT NULL CHECK (submission_window_ms BETWEEN 1 AND 86400000),
      window_schema_version text NOT NULL CHECK (
        window_schema_version = 'bayn.autonomous-cycle-window.v1'
      ),
      execution_session_date date NOT NULL,
      signal_close_at timestamptz NOT NULL,
      publication_deadline_at timestamptz NOT NULL,
      execution_open_at timestamptz NOT NULL,
      execution_close_at timestamptz NOT NULL,
      submission_cutoff_at timestamptz NOT NULL,
      state text NOT NULL CHECK (state IN ('PENDING', 'ACTIVE', 'COMPLETED', 'NO_TRADE', 'BLOCKED')),
      snapshot_id text CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
      decision_hash text CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
      terminal_reason text CHECK (terminal_reason IN (
        'BLOCKED_MISSED_WINDOW',
        'BLOCKED_DATA_UNAVAILABLE',
        'BLOCKED_DATA_STALE',
        'BLOCKED_DATA_INVALID',
        'BLOCKED_PROVENANCE_MISMATCH',
        'BLOCKED_AUTHORITY',
        'BLOCKED_KILL_ACTIVE',
        'BLOCKED_BROKER_DISABLED',
        'BLOCKED_BROKER_UNAVAILABLE',
        'BLOCKED_UNRESOLVED_MUTATION',
        'BLOCKED_RECONCILIATION',
        'BLOCKED_RISK'
      )),
      state_version integer NOT NULL CHECK (state_version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      terminal_at timestamptz,
      UNIQUE (
        qualification_run_id,
        strategy_protocol_hash,
        account_id,
        signal_session_date,
        calendar_version,
        execution_policy_hash
      ),
      CHECK (signal_session_date < execution_session_date),
      CHECK (signal_close_at < execution_open_at),
      CHECK (publication_deadline_at = execution_open_at),
      CHECK (execution_open_at < submission_cutoff_at),
      CHECK (submission_cutoff_at <= execution_close_at),
      CHECK (
        submission_cutoff_at =
          execution_open_at + submission_window_ms * interval '1 millisecond'
      ),
      CHECK (updated_at >= created_at),
      CHECK (decision_hash IS NULL OR snapshot_id IS NOT NULL),
      CHECK (
        (
          state = 'PENDING'
          AND decision_hash IS NULL
          AND terminal_reason IS NULL
          AND terminal_at IS NULL
        )
        OR (
          state = 'ACTIVE'
          AND snapshot_id IS NOT NULL
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
      )
    )
  `

  yield* sql`
    CREATE INDEX autonomous_cycles_unfinished_idx
    ON autonomous_cycles(signal_session_date, cycle_id)
    WHERE state IN ('PENDING', 'ACTIVE')
  `

  yield* sql`
    CREATE FUNCTION enforce_autonomous_cycle_immutability()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'autonomous cycles cannot be deleted' USING ERRCODE = '55000';
      END IF;

      IF OLD.state IN ('COMPLETED', 'NO_TRADE', 'BLOCKED') THEN
        RAISE EXCEPTION 'terminal autonomous cycle history cannot change' USING ERRCODE = '55000';
      END IF;

      IF (
        to_jsonb(OLD) - ARRAY[
          'state',
          'snapshot_id',
          'decision_hash',
          'terminal_reason',
          'state_version',
          'updated_at',
          'terminal_at'
        ]
      ) <> (
        to_jsonb(NEW) - ARRAY[
          'state',
          'snapshot_id',
          'decision_hash',
          'terminal_reason',
          'state_version',
          'updated_at',
          'terminal_at'
        ]
      ) THEN
        RAISE EXCEPTION 'autonomous cycle identity and deadlines cannot change' USING ERRCODE = '55000';
      END IF;

      IF NEW.state_version <> OLD.state_version + 1 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'autonomous cycle version and time must advance monotonically' USING ERRCODE = '23514';
      END IF;
      IF OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
        RAISE EXCEPTION 'autonomous cycle snapshot binding cannot change' USING ERRCODE = '55000';
      END IF;
      IF OLD.decision_hash IS NOT NULL AND NEW.decision_hash IS DISTINCT FROM OLD.decision_hash THEN
        RAISE EXCEPTION 'autonomous cycle decision binding cannot change' USING ERRCODE = '55000';
      END IF;

      RETURN NEW;
    END
    $function$
  `

  yield* sql`
    CREATE TRIGGER autonomous_cycle_immutable_fields
    BEFORE UPDATE OR DELETE ON autonomous_cycles
    FOR EACH ROW EXECUTE FUNCTION enforce_autonomous_cycle_immutability()
  `
  yield* sql`
    CREATE TRIGGER autonomous_cycles_reject_truncate
    BEFORE TRUNCATE ON autonomous_cycles
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
})
