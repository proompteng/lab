import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

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
        IF NOT (
          OLD.maximum = 'OBSERVE'
          AND OLD.effective = 'OBSERVE'
          AND OLD.kill_state = 'ACTIVE'
          AND OLD.reason = 'reconciliation pass incomplete'
          AND NEW.maximum = 'OBSERVE'
          AND NEW.effective = 'OBSERVE'
          AND NEW.kill_state = 'CLEAR'
          AND NEW.reason IS NULL
          AND EXISTS (
            SELECT 1
            FROM authority_generations AS generation
            JOIN authority_generations AS previous_generation
              ON previous_generation.generation_hash = OLD.generation_hash
            JOIN LATERAL (
              SELECT reconciliation.*
              FROM reconciliations AS reconciliation
              WHERE reconciliation.account_id = generation.account_id
              ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id COLLATE "C" DESC
              LIMIT 1
            ) AS reconciliation ON true
            WHERE generation.generation_hash = NEW.generation_hash
              AND generation.previous_generation_hash = OLD.generation_hash
              AND generation.maximum = 'OBSERVE'
              AND generation.authority_version = NEW.version
              AND generation.activated_at = NEW.updated_at
              AND generation.broker_identity_schema_version = 'bayn.broker-identity.v2'
              AND generation.broker_identity_hash IS NOT NULL
              AND generation.account_id IS NOT NULL
              AND (
                (
                  previous_generation.broker_identity_schema_version = generation.broker_identity_schema_version
                  AND previous_generation.broker_identity_hash = generation.broker_identity_hash
                  AND previous_generation.broker_provider = generation.broker_provider
                  AND previous_generation.broker_environment = generation.broker_environment
                  AND previous_generation.account_id = generation.account_id
                )
                OR (
                  generation.broker_provider = 'alpaca'
                  AND generation.broker_environment = 'sandbox'
                  AND previous_generation.generation_hash =
                    'd290539ec85334d8ce267f98919c139cb382068101042d69b5433832136dc063'
                  AND previous_generation.previous_generation_hash IS NULL
                  AND previous_generation.maximum = 'OBSERVE'
                  AND previous_generation.authority_version = 1
                  AND previous_generation.broker_identity_schema_version IS NULL
                  AND previous_generation.broker_identity_hash IS NULL
                  AND previous_generation.broker_provider IS NULL
                  AND previous_generation.broker_environment IS NULL
                  AND previous_generation.account_id IS NULL
                )
              )
              AND reconciliation.status = 'EXACT'
              AND reconciliation.expected_hash = reconciliation.observed_hash
              AND jsonb_array_length(reconciliation.discrepancies) = 0
              AND reconciliation.reconciled_at > OLD.updated_at
              AND reconciliation.reconciled_at < NEW.updated_at
              AND NOT EXISTS (
                SELECT 1
                FROM mutation_events AS mutation
                JOIN intents AS intent ON intent.intent_id = mutation.intent_id
                WHERE intent.account_id = generation.account_id
              )
          )
        ) THEN
          RAISE EXCEPTION 'authority generation changes must preserve kill state exactly'
            USING ERRCODE = '23514';
        END IF;
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
