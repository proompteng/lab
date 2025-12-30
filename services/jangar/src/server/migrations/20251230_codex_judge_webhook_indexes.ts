import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE INDEX IF NOT EXISTS codex_judge_runs_repo_commit_idx
    ON ${sql.ref('codex_judge.runs')} (repository, commit_sha)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS codex_judge_runs_repo_pr_idx
    ON ${sql.ref('codex_judge.runs')} (repository, pr_number)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS codex_judge_runs_repo_branch_idx
    ON ${sql.ref('codex_judge.runs')} (repository, branch)
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
