import { sql } from 'kysely'

import type { Db } from '~/server/db'

export const up = async (db: Db) => {
  await sql`
    ALTER TABLE ${sql.ref('codex_judge.runs')}
    ADD COLUMN IF NOT EXISTS iteration INT,
    ADD COLUMN IF NOT EXISTS iteration_cycle INT;
  `.execute(db)
}

export const down = async (db: Db) => {
  await sql`
    ALTER TABLE ${sql.ref('codex_judge.runs')}
    DROP COLUMN IF EXISTS iteration,
    DROP COLUMN IF EXISTS iteration_cycle;
  `.execute(db)
}
