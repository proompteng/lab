import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE authority_generations
      ADD COLUMN research_plan_hash text
        CHECK (research_plan_hash IS NULL OR research_plan_hash ~ '^[0-9a-f]{64}$'),
      ADD COLUMN strategy_protocol_hash text
        CHECK (strategy_protocol_hash IS NULL OR strategy_protocol_hash ~ '^[0-9a-f]{64}$')
  `

  yield* sql`
    ALTER TABLE authority_generations
      DROP CONSTRAINT authority_generations_activation_schema_version_check,
      ADD CONSTRAINT authority_generations_activation_schema_version_check CHECK (
        activation_schema_version IN (
          'bayn.paper-authority-generation.v2',
          'bayn.paper-authority-generation.v3'
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
          AND research_plan_hash IS NULL
          AND strategy_protocol_hash IS NULL
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
          AND activation_schema_version = 'bayn.paper-authority-generation.v2'
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
          AND research_plan_hash IS NULL
          AND strategy_protocol_hash IS NULL
        )
        OR (
          maximum = 'PAPER'
          AND previous_generation_hash IS NOT NULL
          AND activation_schema_version = 'bayn.paper-authority-generation.v3'
          AND qualification_run_id IS NULL
          AND qualification_lock_id IS NULL
          AND qualification_result_hash IS NULL
          AND protocol_hash IS NULL
          AND qualification_execution_policy_hash IS NULL
          AND qualification_source_revision IS NULL
          AND qualification_image_repository IS NULL
          AND qualification_image_digest IS NULL
          AND activation_source_revision IS NOT NULL
          AND activation_image_repository IS NOT NULL
          AND activation_image_digest IS NOT NULL
          AND strategy_name IS NOT NULL
          AND strategy_behavior_hash IS NOT NULL
          AND strategy_parameter_hash IS NOT NULL
          AND strategy_parameter_schema_version IS NOT NULL
          AND account_id IS NOT NULL
          AND broker_identity_schema_version = 'bayn.broker-identity.v2'
          AND broker_identity_hash IS NOT NULL
          AND broker_provider = 'alpaca'
          AND broker_environment = 'sandbox'
          AND risk_policy_hash IS NOT NULL
          AND proof_plan_hash IS NOT NULL
          AND reconciliation_id IS NOT NULL
          AND reconciliation_content_hash IS NOT NULL
          AND research_plan_hash IS NOT NULL
          AND strategy_protocol_hash IS NOT NULL
        )
      )
  `
})
