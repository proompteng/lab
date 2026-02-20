import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    ALTER TABLE ${sql.ref('codex_judge.evaluations')}
    DROP COLUMN IF EXISTS prompt_tuning;
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS ${sql.ref('codex_judge.prompt_tuning')};
  `.execute(db)
}

export const down = async (db: Kysely<Database>) => {
  await sql`
    ALTER TABLE ${sql.ref('codex_judge.evaluations')}
    ADD COLUMN IF NOT EXISTS prompt_tuning JSONB NOT NULL DEFAULT '{}'::JSONB;
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('codex_judge.prompt_tuning')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES codex_judge.runs(id) ON DELETE CASCADE,
      pr_url TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)
}
