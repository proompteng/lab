import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM intents) OR EXISTS (SELECT 1 FROM risk_decisions) THEN
        RAISE EXCEPTION 'authority-bound intent hard cut requires empty intents and risk_decisions'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `

  yield* sql`
    ALTER TABLE intents
      DROP CONSTRAINT intents_schema_version_check,
      ADD COLUMN authority_generation_hash text NOT NULL CHECK (
        authority_generation_hash ~ '^[0-9a-f]{64}$'
      ),
      ADD CONSTRAINT intents_schema_version_check CHECK (schema_version = 'bayn.paper-intent.v3'),
      ADD CONSTRAINT intents_authority_generation_fk
        FOREIGN KEY (authority_generation_hash)
        REFERENCES authority_generations(generation_hash)
        ON DELETE RESTRICT
  `
})
