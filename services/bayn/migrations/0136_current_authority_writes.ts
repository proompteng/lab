import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  // NOT VALID preserves immutable generations while enforcing the current contract on every new write.
  // Recovery reads the retained predecessor and appends an OBSERVE successor; it never rewrites history.
  yield* sql`ALTER TABLE authority_generations
    DROP CONSTRAINT authority_generations_activation_schema_version_check,
    DROP CONSTRAINT authority_generations_strategy_name_check,
    DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
    DROP CONSTRAINT authority_generations_strategy_contract_check,
    ADD CONSTRAINT authority_generations_activation_schema_version_check CHECK (
      ((maximum = 'OBSERVE' AND activation_schema_version IS NULL)
      OR (maximum = 'PAPER' AND activation_schema_version = 'bayn.paper-authority-generation.v3')) IS TRUE
    ) NOT VALID,
    ADD CONSTRAINT authority_generations_strategy_name_check CHECK (
      strategy_name = 'jev'
    ) NOT VALID,
    ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
      strategy_parameter_schema_version = 'bayn.jev.protocol.v16'
    ) NOT VALID,
    ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
      ((maximum = 'OBSERVE' AND strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
      OR (maximum = 'PAPER' AND strategy_name = 'jev'
        AND strategy_parameter_schema_version = 'bayn.jev.protocol.v16')) IS TRUE
    ) NOT VALID`
})
