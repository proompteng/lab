import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE authority_generations
      ADD COLUMN broker_identity_schema_version text,
      ADD COLUMN broker_identity_hash text,
      ADD COLUMN broker_provider text,
      ADD COLUMN broker_environment text,
      ADD CONSTRAINT authority_generations_broker_identity_check CHECK (
        (
          broker_identity_schema_version IS NULL
          AND broker_identity_hash IS NULL
          AND broker_provider IS NULL
          AND broker_environment IS NULL
        )
        OR (
          broker_identity_schema_version = 'bayn.broker-identity.v2'
          AND broker_identity_hash ~ '^[0-9a-f]{64}$'
          AND broker_provider = 'alpaca'
          AND broker_environment IN ('sandbox', 'live')
          AND account_id IS NOT NULL
        )
      )
  `

  yield* sql`
    ALTER TABLE authority_generations
      DROP CONSTRAINT authority_generations_check,
      ADD CONSTRAINT authority_generations_check CHECK (
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
          AND risk_policy_hash IS NULL
          AND proof_plan_hash IS NULL
          AND reconciliation_id IS NULL
          AND reconciliation_content_hash IS NULL
          AND (
            account_id IS NULL
            OR (
              broker_identity_schema_version = 'bayn.broker-identity.v2'
              AND broker_identity_hash IS NOT NULL
              AND broker_provider = 'alpaca'
              AND broker_environment IN ('sandbox', 'live')
            )
          )
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
  `

  yield* sql`
    CREATE TABLE live_capital_grants (
      grant_hash text PRIMARY KEY CHECK (grant_hash ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.live-capital-grant.v1'),
      broker_identity_schema_version text NOT NULL CHECK (
        broker_identity_schema_version = 'bayn.broker-identity.v2'
      ),
      broker_identity_hash text NOT NULL CHECK (broker_identity_hash ~ '^[0-9a-f]{64}$'),
      broker_provider text NOT NULL CHECK (broker_provider = 'alpaca'),
      broker_environment text NOT NULL CHECK (broker_environment = 'live'),
      account_id text NOT NULL CHECK (length(account_id) > 0 AND account_id = btrim(account_id)),
      authority_generation_hash text NOT NULL REFERENCES authority_generations(generation_hash) ON DELETE RESTRICT,
      strategy_name text NOT NULL CHECK (length(strategy_name) > 0 AND strategy_name = btrim(strategy_name)),
      strategy_behavior_hash text NOT NULL CHECK (strategy_behavior_hash ~ '^[0-9a-f]{64}$'),
      strategy_parameter_hash text NOT NULL CHECK (strategy_parameter_hash ~ '^[0-9a-f]{64}$'),
      strategy_parameter_schema_version text NOT NULL CHECK (
        length(strategy_parameter_schema_version) > 0
        AND strategy_parameter_schema_version = btrim(strategy_parameter_schema_version)
      ),
      max_gross_notional_micros numeric(39, 0) NOT NULL CHECK (max_gross_notional_micros > 0),
      max_order_notional_micros numeric(39, 0) NOT NULL CHECK (max_order_notional_micros > 0),
      max_position_notional_micros numeric(39, 0) NOT NULL CHECK (max_position_notional_micros > 0),
      max_daily_loss_micros numeric(39, 0) NOT NULL CHECK (max_daily_loss_micros > 0),
      max_open_orders integer NOT NULL CHECK (max_open_orders > 0),
      valid_from timestamptz NOT NULL,
      valid_until timestamptz NOT NULL CHECK (valid_until > valid_from),
      issued_at timestamptz NOT NULL CHECK (issued_at <= valid_from),
      issued_by text NOT NULL CHECK (length(issued_by) > 0 AND issued_by = btrim(issued_by))
    )
  `

  yield* sql`
    CREATE TABLE live_capital_grant_revocations (
      grant_hash text PRIMARY KEY REFERENCES live_capital_grants(grant_hash) ON DELETE RESTRICT,
      schema_version text NOT NULL CHECK (schema_version = 'bayn.live-capital-grant-revocation.v1'),
      revoked_at timestamptz NOT NULL,
      revoked_by text NOT NULL CHECK (length(revoked_by) > 0 AND revoked_by = btrim(revoked_by)),
      reason text NOT NULL CHECK (length(reason) > 0 AND reason = btrim(reason))
    )
  `

  yield* sql`
    CREATE TRIGGER live_capital_grants_append_only
    BEFORE UPDATE OR DELETE ON live_capital_grants
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER live_capital_grants_reject_truncate
    BEFORE TRUNCATE ON live_capital_grants
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER live_capital_grant_revocations_append_only
    BEFORE UPDATE OR DELETE ON live_capital_grant_revocations
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER live_capital_grant_revocations_reject_truncate
    BEFORE TRUNCATE ON live_capital_grant_revocations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
})
