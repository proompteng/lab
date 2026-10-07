import type { PgClient } from '@effect/sql-pg'
import type { Fragment } from 'effect/sql/Statement'

/** Evaluated by PostgreSQL inside each consuming statement. */
export interface DatabaseClock {
  readonly now: Fragment
}

export const postgresWallClock = (sql: PgClient.PgClient): DatabaseClock => ({ now: sql`clock_timestamp()` })

/** Preserve database identity precision without changing historical millisecond hashes. */
export const databaseUtcInstant = (sql: PgClient.PgClient, value: Fragment): Fragment =>
  sql`regexp_replace(to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '000Z$', 'Z')`
