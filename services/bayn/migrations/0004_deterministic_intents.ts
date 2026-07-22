import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM intents) OR EXISTS (SELECT 1 FROM risk_decisions) THEN
        RAISE EXCEPTION 'deterministic intent hard cut requires empty intents and risk_decisions'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `

  yield* sql`
    ALTER TABLE intents
      DROP CONSTRAINT intents_schema_version_check,
      ADD COLUMN strategy_name text NOT NULL CHECK (
        length(strategy_name) > 0 AND strategy_name = btrim(strategy_name)
      ),
      ADD COLUMN cycle_id text NOT NULL CHECK (cycle_id ~ '^[0-9a-f]{64}$'),
      ADD COLUMN decision_hash text NOT NULL CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
      ADD COLUMN policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT intents_schema_version_check CHECK (schema_version = 'bayn.paper-intent.v2'),
      ADD CONSTRAINT intents_client_order_id_length CHECK (length(client_order_id) <= 48),
      ADD CONSTRAINT intents_decision_target_unique UNIQUE (
        account_id,
        strategy_name,
        cycle_id,
        decision_hash,
        symbol
      )
  `

  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_risk_decision_binding()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM intents
        WHERE intent_id = NEW.intent_id
          AND risk_decision_id = NEW.decision_id
          AND policy_hash = NEW.policy_hash
      ) THEN
        RAISE EXCEPTION 'risk decision is not bound to its intent and policy' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `
})
