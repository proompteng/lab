import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    ALTER TABLE ${sql.ref('codex_judge.runs')}
    ADD COLUMN IF NOT EXISTS turn_id TEXT
  `.execute(db)

  await sql`
    ALTER TABLE ${sql.ref('codex_judge.runs')}
    ADD COLUMN IF NOT EXISTS thread_id TEXT
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
