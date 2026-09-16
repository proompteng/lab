import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Select the latest account snapshot once before checking flatness and the reconciliation cutoff.
  // The previous anti-join compared each retained snapshot with its later history during rollover.
  yield* sql`
    DO $migration$
    DECLARE
      function_definition text := pg_get_functiondef(
        'research_paper_rearm_eligible(text,bigint,timestamptz)'::regprocedure
      );
      previous_query constant text := $previous$
                SELECT 1
                FROM position_snapshots AS snapshot
                WHERE snapshot.account_id = previous_generation.account_id
                  AND snapshot.position_count = 0
                  AND snapshot.observed_at <= reconciliation.reconciled_at
                  AND NOT EXISTS (
                    SELECT 1
                    FROM position_snapshots AS later
                    WHERE later.account_id = snapshot.account_id
                      AND (
                        later.observed_at > snapshot.observed_at
                        OR (
                          later.observed_at = snapshot.observed_at
                          AND later.snapshot_id COLLATE "C" > snapshot.snapshot_id COLLATE "C"
                        )
                      )
                  )$previous$;
      latest_query constant text := $latest$
                SELECT 1
                FROM (
                  SELECT snapshot.position_count, snapshot.observed_at
                  FROM position_snapshots AS snapshot
                  WHERE snapshot.account_id = previous_generation.account_id
                  ORDER BY snapshot.observed_at DESC, snapshot.snapshot_id COLLATE "C" DESC
                  LIMIT 1
                ) AS latest_position
                WHERE latest_position.position_count = 0
                  AND latest_position.observed_at <= reconciliation.reconciled_at$latest$;
    BEGIN
      IF (
        length(function_definition) - length(replace(function_definition, previous_query, ''))
      ) <> length(previous_query) THEN
        RAISE EXCEPTION 'expected exactly one research rearm position query' USING ERRCODE = '55000';
      END IF;

      EXECUTE replace(function_definition, previous_query, latest_query);
    END
    $migration$
  `
})
