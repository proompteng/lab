import type { PgClient } from '@effect/sql-pg'
import type { Fragment } from 'effect/unstable/sql/Statement'

/** Evaluated by PostgreSQL inside each consuming statement. */
export interface DatabaseClock {
  readonly now: Fragment
}

export const postgresWallClock = (sql: PgClient.PgClient): DatabaseClock => ({ now: sql`clock_timestamp()` })
