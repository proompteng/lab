import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    DO $block$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM authority_state
        WHERE maximum = 'PAPER'
      ) THEN
        RAISE EXCEPTION 'cannot create authority generation history from unaudited PAPER state'
          USING ERRCODE = '23514';
      END IF;
    END;
    $block$
  `

  yield* sql`
    CREATE TABLE authority_generations (
      generation_hash text PRIMARY KEY CHECK (generation_hash ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.authority-generation-history.v1'),
      activation_schema_version text CHECK (
        activation_schema_version = 'bayn.paper-authority-generation.v1'
      ),
      previous_generation_hash text REFERENCES authority_generations(generation_hash) ON DELETE RESTRICT,
      maximum text NOT NULL CHECK (maximum IN ('OBSERVE', 'PAPER')),
      authority_version bigint NOT NULL UNIQUE CHECK (authority_version > 0),
      qualification_run_id text REFERENCES qualification_results(run_id) ON DELETE RESTRICT,
      qualification_lock_id text REFERENCES qualification_results(lock_id) ON DELETE RESTRICT,
      qualification_result_hash text REFERENCES qualification_results(result_hash) ON DELETE RESTRICT,
      protocol_hash text REFERENCES protocol_locks(protocol_hash) ON DELETE RESTRICT,
      qualification_execution_policy_hash text CHECK (
        qualification_execution_policy_hash ~ '^[0-9a-f]{64}$'
      ),
      qualification_source_revision text CHECK (
        qualification_source_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
      ),
      qualification_image_repository text CHECK (
        length(qualification_image_repository) > 0
        AND qualification_image_repository = btrim(qualification_image_repository)
      ),
      qualification_image_digest text CHECK (
        qualification_image_digest ~ '^sha256:[0-9a-f]{64}$'
      ),
      activation_source_revision text CHECK (
        activation_source_revision ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
      ),
      activation_image_repository text CHECK (
        length(activation_image_repository) > 0
        AND activation_image_repository = btrim(activation_image_repository)
      ),
      activation_image_digest text CHECK (
        activation_image_digest ~ '^sha256:[0-9a-f]{64}$'
      ),
      strategy_name text CHECK (strategy_name = 'risk-balanced-trend'),
      strategy_behavior_hash text CHECK (strategy_behavior_hash ~ '^[0-9a-f]{64}$'),
      strategy_parameter_hash text CHECK (strategy_parameter_hash ~ '^[0-9a-f]{64}$'),
      strategy_parameter_schema_version text CHECK (
        strategy_parameter_schema_version = 'bayn.risk-balanced-trend.protocol.v3'
      ),
      account_id text CHECK (length(account_id) > 0 AND account_id = btrim(account_id)),
      risk_policy_hash text CHECK (risk_policy_hash ~ '^[0-9a-f]{64}$'),
      proof_plan_hash text CHECK (proof_plan_hash ~ '^[0-9a-f]{64}$'),
      reconciliation_id text REFERENCES reconciliations(reconciliation_id) ON DELETE RESTRICT,
      reconciliation_content_hash text CHECK (reconciliation_content_hash ~ '^[0-9a-f]{64}$'),
      activated_at timestamptz NOT NULL,
      CHECK (
        (
          maximum = 'OBSERVE'
          AND activation_schema_version IS NULL
          AND qualification_run_id IS NULL
          AND qualification_lock_id IS NULL
          AND qualification_result_hash IS NULL
          AND protocol_hash IS NULL
          AND qualification_execution_policy_hash IS NULL
          AND qualification_source_revision IS NULL
          AND qualification_image_repository IS NULL
          AND qualification_image_digest IS NULL
          AND activation_source_revision IS NULL
          AND activation_image_repository IS NULL
          AND activation_image_digest IS NULL
          AND strategy_name IS NULL
          AND strategy_behavior_hash IS NULL
          AND strategy_parameter_hash IS NULL
          AND strategy_parameter_schema_version IS NULL
          AND account_id IS NULL
          AND risk_policy_hash IS NULL
          AND proof_plan_hash IS NULL
          AND reconciliation_id IS NULL
          AND reconciliation_content_hash IS NULL
        )
        OR (
          maximum = 'PAPER'
          AND previous_generation_hash IS NOT NULL
          AND activation_schema_version IS NOT NULL
          AND qualification_run_id IS NOT NULL
          AND qualification_lock_id IS NOT NULL
          AND qualification_result_hash IS NOT NULL
          AND protocol_hash IS NOT NULL
          AND qualification_execution_policy_hash IS NOT NULL
          AND qualification_source_revision IS NOT NULL
          AND qualification_image_repository IS NOT NULL
          AND qualification_image_digest IS NOT NULL
          AND activation_source_revision IS NOT NULL
          AND activation_image_repository IS NOT NULL
          AND activation_image_digest IS NOT NULL
          AND strategy_name IS NOT NULL
          AND strategy_behavior_hash IS NOT NULL
          AND strategy_parameter_hash IS NOT NULL
          AND strategy_parameter_schema_version IS NOT NULL
          AND account_id IS NOT NULL
          AND risk_policy_hash IS NOT NULL
          AND proof_plan_hash IS NOT NULL
          AND reconciliation_id IS NOT NULL
          AND reconciliation_content_hash IS NOT NULL
        )
      )
    )
  `

  yield* sql`
    INSERT INTO authority_generations (
      generation_hash, schema_version, previous_generation_hash, maximum,
      authority_version, activated_at
    )
    SELECT
      generation_hash, 'bayn.authority-generation-history.v1', NULL, maximum,
      version, updated_at
    FROM authority_state
    WHERE singleton AND maximum = 'OBSERVE'
  `

  yield* sql`
    CREATE TRIGGER authority_generations_append_only
    BEFORE UPDATE OR DELETE ON authority_generations
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER authority_generations_reject_truncate
    BEFORE TRUNCATE ON authority_generations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `

  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_authority_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'authority state cannot be deleted' USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.version <> 1
          OR NEW.maximum <> 'OBSERVE'
          OR NEW.effective <> 'OBSERVE'
          OR NEW.kill_state <> 'CLEAR'
          OR NEW.reason IS NOT NULL
        THEN
          RAISE EXCEPTION 'authority state must begin as clear OBSERVE at version 1'
            USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM authority_generations AS generation
          WHERE generation.generation_hash = NEW.generation_hash
            AND generation.previous_generation_hash IS NULL
            AND generation.maximum = 'OBSERVE'
            AND generation.authority_version = 1
            AND generation.activated_at = NEW.updated_at
        ) THEN
          RAISE EXCEPTION 'initial authority state lacks matching immutable OBSERVE history'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.singleton <> OLD.singleton
        OR NEW.schema_version <> OLD.schema_version
        OR NEW.version <> OLD.version + 1
        OR NEW.updated_at <= OLD.updated_at
      THEN
        RAISE EXCEPTION 'invalid authority state version' USING ERRCODE = '23514';
      END IF;

      IF NEW.generation_hash = OLD.generation_hash THEN
        IF NEW.maximum <> OLD.maximum
          OR (OLD.effective = 'OBSERVE' AND NEW.effective = 'PAPER')
          OR (OLD.kill_state = 'ACTIVE' AND NEW.kill_state = 'CLEAR')
        THEN
          RAISE EXCEPTION 'authority can only decrease within a GitOps generation' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.kill_state IS DISTINCT FROM OLD.kill_state
        OR NEW.reason IS DISTINCT FROM OLD.reason
      THEN
        RAISE EXCEPTION 'authority generation changes must preserve kill state exactly'
          USING ERRCODE = '23514';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM authority_generations AS generation
        WHERE generation.generation_hash = NEW.generation_hash
          AND generation.previous_generation_hash = OLD.generation_hash
          AND generation.maximum = NEW.maximum
          AND generation.authority_version = NEW.version
          AND generation.activated_at = NEW.updated_at
      ) THEN
        RAISE EXCEPTION 'authority generation change lacks matching immutable history'
          USING ERRCODE = '23514';
      END IF;

      IF NEW.maximum = 'PAPER' THEN
        IF OLD.maximum <> 'OBSERVE'
          OR NEW.effective <> (
            CASE WHEN NEW.kill_state = 'ACTIVE' THEN 'OBSERVE' ELSE 'PAPER' END
          )
        THEN
          RAISE EXCEPTION 'invalid PAPER authority generation transition' USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.effective <> 'OBSERVE' THEN
        RAISE EXCEPTION 'OBSERVE generation must remain effectively OBSERVE' USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `
})
