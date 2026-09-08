import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`
    CREATE TABLE IF NOT EXISTS agent_run_rerun_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_ref TEXT NOT NULL,
      parent_agent_run_id TEXT,
      parent_agent_run_name TEXT,
      parent_agent_run_namespace TEXT,
      attempt INTEGER NOT NULL,
      delivery_id TEXT NOT NULL,
      status TEXT NOT NULL,
      submission_attempt INTEGER NOT NULL DEFAULT 0,
      response_status INTEGER,
      error TEXT,
      request_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      response_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      submitted_at TIMESTAMPTZ
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_run_rerun_parent_attempt_idx
    ON agent_run_rerun_submissions(parent_ref, attempt);
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_run_rerun_delivery_id_idx
    ON agent_run_rerun_submissions(delivery_id);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agent_run_rerun_status_updated_idx
    ON agent_run_rerun_submissions(status, updated_at);
  `.execute(db)
}

export const down = async (_db: Kysely<AgentsDatabase>) => {}
