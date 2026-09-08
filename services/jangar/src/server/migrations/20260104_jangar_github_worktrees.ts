import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    ALTER TABLE ${sql.ref('jangar_github.pr_files')}
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'worktree'
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS jangar_github.pr_worktrees (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository text NOT NULL,
      pr_number integer NOT NULL,
      worktree_name text NOT NULL,
      worktree_path text NOT NULL,
      base_sha text,
      head_sha text,
      last_refreshed_at timestamptz NOT NULL,
      UNIQUE (repository, pr_number)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS jangar_github_pr_worktrees_repo_idx
    ON jangar_github.pr_worktrees (repository, pr_number)
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
