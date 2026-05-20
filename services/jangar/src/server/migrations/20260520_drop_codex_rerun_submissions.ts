import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`DROP TABLE IF EXISTS ${sql.ref('codex_judge.rerun_submissions')}`.execute(db)
}
