import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('codex_judge.rerun_submissions')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_run_id UUID NOT NULL REFERENCES codex_judge.runs(id) ON DELETE CASCADE,
      attempt INT NOT NULL,
      delivery_id TEXT NOT NULL,
      status TEXT NOT NULL,
      submission_attempt INT NOT NULL DEFAULT 0,
      response_status INT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      submitted_at TIMESTAMPTZ,
      UNIQUE (parent_run_id, attempt),
      UNIQUE (delivery_id)
    );
  `.execute(db)
}
