import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM autonomous_cycles WHERE decision_hash IS NOT NULL) THEN
        RAISE EXCEPTION 'shadow decision hard cut requires no preexisting autonomous cycle decision binding'
          USING ERRCODE = '55000';
      END IF;
    END
    $migration$
  `

  yield* sql`
    CREATE TABLE autonomous_cycle_shadow_decisions (
      cycle_id text PRIMARY KEY REFERENCES autonomous_cycles(cycle_id) ON DELETE RESTRICT
        CHECK (cycle_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.observe-shadow-decision.v1'),
      document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
      decision_hash text GENERATED ALWAYS AS (document ->> 'contentHash') STORED NOT NULL
        CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL,
      UNIQUE (cycle_id, decision_hash),
      CHECK (
        document ->> 'schemaVersion' = schema_version
        AND document ->> 'mode' = 'OBSERVE'
        AND document ->> 'dispatchable' = 'false'
        AND document #>> '{bindings,cycleId}' = cycle_id
        AND (document ->> 'createdAt')::timestamptz = created_at
      )
    )
  `

  yield* sql`
    ALTER TABLE autonomous_cycles
    ADD CONSTRAINT autonomous_cycles_shadow_decision_fk
    FOREIGN KEY (cycle_id, decision_hash)
    REFERENCES autonomous_cycle_shadow_decisions(cycle_id, decision_hash)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
  `

  yield* sql`
    CREATE FUNCTION enforce_autonomous_cycle_shadow_binding()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM autonomous_cycles
        WHERE cycle_id = NEW.cycle_id
          AND decision_hash = NEW.decision_hash
      ) THEN
        RAISE EXCEPTION 'shadow decision must bind atomically to its autonomous cycle'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `

  yield* sql`
    CREATE CONSTRAINT TRIGGER autonomous_cycle_shadow_decision_binding
    AFTER INSERT ON autonomous_cycle_shadow_decisions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_autonomous_cycle_shadow_binding()
  `

  yield* sql`
    CREATE TRIGGER autonomous_cycle_shadow_decisions_append_only
    BEFORE UPDATE OR DELETE ON autonomous_cycle_shadow_decisions
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `

  yield* sql`
    CREATE TRIGGER autonomous_cycle_shadow_decisions_reject_truncate
    BEFORE TRUNCATE ON autonomous_cycle_shadow_decisions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
})
