import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE TABLE IF NOT EXISTS agent_run_idempotency_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      namespace TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      agent_run_name TEXT,
      agent_run_uid TEXT,
      terminal_phase TEXT,
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_run_idempotency_scope_idx
    ON agent_run_idempotency_keys(namespace, agent_name, idempotency_key);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agent_run_idempotency_terminal_at_idx
    ON agent_run_idempotency_keys(terminal_at);
  `.execute(db)
}
