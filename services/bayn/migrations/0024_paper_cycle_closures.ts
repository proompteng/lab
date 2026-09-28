import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE autonomous_cycle_paper_closures (
      cycle_id text PRIMARY KEY REFERENCES autonomous_cycles(cycle_id) ON DELETE RESTRICT
        CHECK (cycle_id ~ '^[0-9a-f]{64}$'),
      document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      close_decision_hash text GENERATED ALWAYS AS (document #>> '{document,contentHash}') STORED NOT NULL
        CHECK (close_decision_hash ~ '^[0-9a-f]{64}$'),
      content_hash text GENERATED ALWAYS AS (document ->> 'contentHash') STORED NOT NULL
        CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      CHECK (document ->> 'schemaVersion' = 'bayn.paper-cycle-closure.v1'),
      CHECK (document ->> 'cycleId' = cycle_id),
      CHECK (document ->> 'createdAt' IS NOT NULL),
      CHECK ((document ->> 'createdAt')::timestamptz = created_at),
      CHECK ((document ->> 'expiresAt')::timestamptz = expires_at),
      CHECK (document #>> '{document,mode}' = 'PAPER'),
      CHECK (document #>> '{document,bindings,cycleId}' = cycle_id),
      CHECK (document #>> '{document,submissionCutoffAt}' = document ->> 'expiresAt'),
      CHECK (document #>> '{document,expiresAt}' = document ->> 'expiresAt')
    )
  `

  yield* sql`
    CREATE TRIGGER autonomous_cycle_paper_closures_append_only
    BEFORE UPDATE OR DELETE ON autonomous_cycle_paper_closures
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `

  yield* sql`
    CREATE TRIGGER autonomous_cycle_paper_closures_reject_truncate
    BEFORE TRUNCATE ON autonomous_cycle_paper_closures
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
})
