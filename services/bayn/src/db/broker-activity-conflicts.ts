import type { PgClient } from '@effect/sql-pg'

/** Raw witnesses remain immutable; PostgreSQL compares every JSON value without JavaScript numeric rounding. */
export const brokerActivitySourceContentIsConsistent = (sql: PgClient.PgClient, accountId: string) =>
  sql`NOT EXISTS (
    SELECT 1 FROM broker_activity_source_conflicts AS conflict
    LEFT JOIN broker_activity_events AS original
      ON original.account_id = conflict.account_id AND original.source_event_id = conflict.source_event_id
    WHERE conflict.account_id = ${accountId} AND (
      original.source_event_id IS NULL
      OR conflict.retained_source_event_hash IS DISTINCT FROM original.source_event_hash
      OR original.source_event_hash <> encode(sha256(convert_to(original.activity_json, 'UTF8')), 'hex')
      OR conflict.conflicting_source_event_hash <> encode(sha256(convert_to(conflict.activity_json, 'UTF8')), 'hex')
      OR original.activity_json::jsonb IS DISTINCT FROM conflict.activity_json::jsonb
    )
  )`
