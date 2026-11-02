import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    ALTER TABLE jangar_github.pr_worktrees
      ADD COLUMN IF NOT EXISTS refresh_failure_reason text,
      ADD COLUMN IF NOT EXISTS refresh_failed_at timestamptz,
      ADD COLUMN IF NOT EXISTS refresh_blocked_until timestamptz
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS jangar_github_pr_worktrees_refresh_blocked_until_idx
    ON jangar_github.pr_worktrees (refresh_blocked_until)
    WHERE refresh_blocked_until IS NOT NULL
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
