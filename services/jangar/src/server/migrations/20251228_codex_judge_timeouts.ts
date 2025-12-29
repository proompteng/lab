import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    ALTER TABLE ${sql.ref('codex_judge.runs')}
    ADD COLUMN IF NOT EXISTS ci_status_updated_at TIMESTAMPTZ
  `.execute(db)

  await sql`
    ALTER TABLE ${sql.ref('codex_judge.runs')}
    ADD COLUMN IF NOT EXISTS review_status_updated_at TIMESTAMPTZ
  `.execute(db)

  await sql`
    UPDATE ${sql.ref('codex_judge.runs')}
    SET ci_status_updated_at = updated_at
    WHERE ci_status_updated_at IS NULL AND ci_status IS NOT NULL
  `.execute(db)

  await sql`
    UPDATE ${sql.ref('codex_judge.runs')}
    SET review_status_updated_at = updated_at
    WHERE review_status_updated_at IS NULL AND review_status IS NOT NULL
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
