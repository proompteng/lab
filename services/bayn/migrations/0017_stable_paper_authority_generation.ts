import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM intents) OR EXISTS (SELECT 1 FROM risk_decisions) THEN
        RAISE EXCEPTION 'stable PAPER authority generation hard cut requires empty intents and risk_decisions'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM authority_generations
        WHERE maximum = 'PAPER'
      ) OR EXISTS (
        SELECT 1
        FROM authority_state
        WHERE maximum = 'PAPER'
      ) THEN
        RAISE EXCEPTION 'stable PAPER authority generation hard cut requires no existing PAPER authority'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `

  yield* sql`
    ALTER TABLE authority_generations
      DROP CONSTRAINT authority_generations_activation_schema_version_check,
      ADD CONSTRAINT authority_generations_activation_schema_version_check CHECK (
        activation_schema_version = 'bayn.paper-authority-generation.v2'
      )
  `
})
