import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE jev_inference_work ADD COLUMN source_sha256 bytea
    CHECK (octet_length(source_sha256) = 32)`
  yield* sql`DROP TRIGGER guard_jev_inference_work ON jev_inference_work`
  // Only unresolved, unclaimed work can use its new seal to dispatch after the upgrade.
  yield* sql`UPDATE jev_inference_work AS work
    SET source_sha256 = sha256(convert_to(observation.payload::text, 'UTF8'))
    FROM jev_batch_plans AS plan
    JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash
    WHERE work.batch_id = plan.batch_id AND work.claimed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM jev_batch_results AS result WHERE result.batch_id = work.batch_id)`
  yield* sql`CREATE OR REPLACE FUNCTION guard_jev_inference_work() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        SELECT sha256(convert_to(observation.payload::text, 'UTF8')) INTO STRICT NEW.source_sha256
        FROM jev_batch_plans AS plan
        JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash
        WHERE plan.batch_id = NEW.batch_id;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' OR OLD.batch_id IS DISTINCT FROM NEW.batch_id
        OR OLD.dispatches IS DISTINCT FROM NEW.dispatches
        OR OLD.admission_deadline_at IS DISTINCT FROM NEW.admission_deadline_at
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR OLD.source_sha256 IS DISTINCT FROM NEW.source_sha256
        OR OLD.claimed_at IS NOT NULL OR NEW.claimed_at IS NULL THEN
        RAISE EXCEPTION 'Jev inference work permits only its first dispatch claim';
      END IF;
      RETURN NEW;
    END $$`
  yield* sql`CREATE TRIGGER guard_jev_inference_work BEFORE INSERT OR UPDATE OR DELETE ON jev_inference_work
    FOR EACH ROW EXECUTE FUNCTION guard_jev_inference_work()`
})
