import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`
    CREATE TABLE IF NOT EXISTS linear_mcp_mutation_receipts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_run_uid TEXT NOT NULL,
      agent_run_name TEXT NOT NULL,
      agent_run_namespace TEXT NOT NULL,
      issue_uuid TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      tool TEXT NOT NULL CHECK (tool IN ('create_comment', 'update_issue')),
      canonical_argument_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('preparing', 'in_flight', 'succeeded', 'indeterminate')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      sanitized_result_id TEXT,
      last_error_code TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS linear_mcp_mutation_receipt_dedupe_idx
    ON linear_mcp_mutation_receipts(agent_run_uid, tool, canonical_argument_hash);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS linear_mcp_mutation_receipt_state_updated_idx
    ON linear_mcp_mutation_receipts(state, updated_at);
  `.execute(db)
}

export const down = async (_db: Kysely<AgentsDatabase>) => {}
