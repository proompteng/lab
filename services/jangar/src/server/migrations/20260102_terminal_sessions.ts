import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

const SCHEMA = 'terminals'
const TABLE = 'sessions'

export const up = async (db: Kysely<Database>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql.raw(SCHEMA)};`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref(`${SCHEMA}.${TABLE}`)} (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      worktree_name TEXT,
      worktree_path TEXT,
      tmux_socket TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ready_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS terminal_sessions_status_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (status, created_at DESC);
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
