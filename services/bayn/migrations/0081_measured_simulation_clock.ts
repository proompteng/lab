import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE simulated_execution_clocks
    ADD COLUMN measured_at timestamptz,
    ADD COLUMN measured_observed_at timestamptz,
    ADD CONSTRAINT measured_clock_pair CHECK ((measured_at IS NULL) = (measured_observed_at IS NULL))`
  yield* sql`
    CREATE FUNCTION execution_account_commit_now(account text) RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $function$
    DECLARE observed timestamptz; measured timestamptz;
    BEGIN
      IF account !~ '^replay-[0-9a-f]{64}$' THEN RETURN clock_timestamp(); END IF;
      SELECT coalesce(measured_observed_at, observed_at), measured_at INTO observed, measured
        FROM simulated_execution_clocks WHERE account_id = account;
      IF NOT FOUND THEN RAISE EXCEPTION 'simulation account has no execution clock' USING ERRCODE = '23514'; END IF;
      IF measured IS NULL THEN RETURN observed; END IF;
      RETURN observed + greatest(interval '0 seconds', clock_timestamp() - measured);
    END
    $function$
  `
  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_jev_exit_commit_deadline() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE checked_at timestamptz; deadline_at timestamptz;
    BEGIN
      IF NEW.document #>> '{document,strategyDecision,schemaVersion}' = 'bayn.jev-exit-target.v1' THEN
        checked_at := execution_account_commit_now(NEW.document #>> '{document,bindings,accountId}');
        deadline_at := (NEW.document #>> '{document,strategyDecision,commitDeadlineAt}')::timestamptz;
        IF deadline_at IS NULL OR checked_at < NEW.created_at OR checked_at >= deadline_at THEN
          RAISE EXCEPTION 'initial Jev exit evidence expired before transaction commitment' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `
})
