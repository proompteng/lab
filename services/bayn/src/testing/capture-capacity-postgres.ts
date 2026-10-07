import type { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

const decodeWaiters = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ pid: Schema.Int, query_start: Schema.String })),
)

/**
 * Run on the transaction holding the fixture's ACCESS EXCLUSIVE table lock.
 * The append prefix survives activity-text truncation and excludes later seal reads.
 */
export const readCapacityAppendWaiters = (sql: PgClient.PgClient) =>
  sql`
    SELECT activity.pid, activity.query_start::text AS query_start
    FROM pg_stat_activity activity
    WHERE activity.pid <> pg_backend_pid()
      AND activity.application_name = 'bayn'
      AND activity.state = 'active'
      AND activity.wait_event_type = 'Lock'
      AND activity.query ~ '^[[:space:]]*WITH[[:space:]]+candidate[[:space:]]+AS[[:space:]]+MATERIALIZED[[:space:]]*[(]'
      AND pg_backend_pid() = ANY(pg_blocking_pids(activity.pid))
      AND EXISTS (
        SELECT 1 FROM pg_locks waiting
        WHERE waiting.pid = activity.pid
          AND waiting.locktype = 'relation'
          AND waiting.relation = 'research_capture_chunks'::regclass
          AND NOT waiting.granted
      )
  `.pipe(Effect.flatMap(decodeWaiters))
