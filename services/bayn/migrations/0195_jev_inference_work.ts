import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE jev_inference_work (
    batch_id text PRIMARY KEY REFERENCES jev_batch_plans(batch_id),
    dispatches jsonb NOT NULL CHECK (jsonb_typeof(dispatches) = 'array' AND jsonb_array_length(dispatches) > 0),
    admission_deadline_at timestamptz,
    claimed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`
  yield* sql`CREATE FUNCTION guard_jev_inference_work() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' OR OLD.batch_id IS DISTINCT FROM NEW.batch_id
      OR OLD.dispatches IS DISTINCT FROM NEW.dispatches
      OR OLD.admission_deadline_at IS DISTINCT FROM NEW.admission_deadline_at
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.claimed_at IS NOT NULL OR NEW.claimed_at IS NULL THEN
      RAISE EXCEPTION 'Jev inference work permits only its first dispatch claim';
    END IF;
    RETURN NEW;
  END $$`
  yield* sql`CREATE TRIGGER guard_jev_inference_work BEFORE UPDATE OR DELETE ON jev_inference_work
    FOR EACH ROW EXECUTE FUNCTION guard_jev_inference_work()`
  yield* sql`CREATE TRIGGER jev_inference_work_no_truncate BEFORE TRUNCATE ON jev_inference_work
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TABLE jev_inference_recovery_cursor (
    account_id text PRIMARY KEY CHECK (length(account_id) > 0),
    last_expires_at text NOT NULL,
    last_batch_id text NOT NULL CHECK (last_batch_id ~ '^[0-9a-f]{64}$'),
    next_attempt_at timestamptz
  )`
})
