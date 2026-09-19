import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE forward_performance_windows (
      window_id text PRIMARY KEY CHECK (window_id ~ '^[0-9a-f]{64}$'),
      authority_generation_hash text NOT NULL REFERENCES authority_generations(generation_hash) ON DELETE RESTRICT,
      first_cycle_id text NOT NULL REFERENCES autonomous_cycles(cycle_id) ON DELETE RESTRICT,
      last_cycle_id text NOT NULL REFERENCES autonomous_cycles(cycle_id) ON DELETE RESTRICT,
      reconciliation_id text NOT NULL REFERENCES reconciliations(reconciliation_id) ON DELETE RESTRICT,
      evidence_cutoff_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
      content_hash text GENERATED ALWAYS AS (document ->> 'contentHash') STORED NOT NULL
        CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      CHECK (document ->> 'schemaVersion' = 'bayn.forward-performance-window.v1'),
      CHECK (document ->> 'windowId' = window_id),
      CHECK (document ->> 'authorityGenerationHash' = authority_generation_hash),
      CHECK (document #>> '{receipt,window,firstCycleId}' = first_cycle_id),
      CHECK (document #>> '{receipt,window,lastCycleId}' = last_cycle_id),
      CHECK (document #>> '{receipt,window,reconciliationId}' = reconciliation_id),
      CHECK ((document #>> '{receipt,window,closedAt}')::timestamptz = evidence_cutoff_at),
      CHECK (document #>> '{receipt,evidence,status}' = 'SUFFICIENT')
    )
  `
  yield* sql`
    CREATE INDEX forward_performance_windows_generation_cut
    ON forward_performance_windows (authority_generation_hash, evidence_cutoff_at DESC, recorded_at DESC, window_id)
  `
  yield* sql`
    CREATE TRIGGER forward_performance_windows_append_only
    BEFORE UPDATE OR DELETE ON forward_performance_windows
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER forward_performance_windows_reject_truncate
    BEFORE TRUNCATE ON forward_performance_windows
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `
})
